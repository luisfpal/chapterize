//! Native side of Chapterize.
//!
//! Deliberately thin: all EPUB logic lives in TypeScript so it can be tested in
//! Node and reused by any other front end. Rust owns only what a webview cannot
//! do — reading arbitrary files, writing a library folder, and moving the
//! original book out of the inbox.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::{Emitter, Manager};

#[derive(Serialize)]
pub struct AnalysisFile {
    name: String,
    path: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
pub struct AppDirs {
    /// Where books live. User data, never cache — losing it loses annotations.
    library: String,
    /// Where settings live, kept separate from data per XDG.
    config: String,
}

#[derive(Deserialize)]
pub struct OutputFile {
    name: String,
    contents: String,
}

/// Expand a leading `~/` so paths stored in JSON stay portable between machines.
fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// The platform's conventional locations, resolved by Tauri rather than guessed.
///
///   Linux    ~/.local/share/dev.l11.chapterize   ~/.config/dev.l11.chapterize
///   macOS    ~/Library/Application Support/...   ~/Library/Application Support/...
///   Windows  %LOCALAPPDATA%                      %APPDATA%
///
/// Local app data, not roaming: a library of EPUBs must not follow a Windows
/// domain profile across the network.
#[tauri::command]
fn app_dirs(app: tauri::AppHandle) -> Result<AppDirs, String> {
    let resolver = app.path();
    let data = resolver
        .app_local_data_dir()
        .map_err(|e| format!("Cannot resolve the application data directory: {e}"))?;
    let config = resolver
        .app_config_dir()
        .map_err(|e| format!("Cannot resolve the application config directory: {e}"))?;
    let library = data.join("library");
    fs::create_dir_all(&library)
        .map_err(|e| format!("Cannot create {}: {e}", library.display()))?;
    fs::create_dir_all(&config)
        .map_err(|e| format!("Cannot create {}: {e}", config.display()))?;
    Ok(AppDirs {
        library: library.to_string_lossy().into_owned(),
        config: config.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn read_file(path: String) -> Result<Vec<u8>, String> {
    let path = expand(&path);
    fs::read(&path).map_err(|e| format!("Cannot read {}: {e}", path.display()))
}

#[tauri::command]
fn read_text(path: String) -> Result<Option<String>, String> {
    let path = expand(&path);
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("Cannot read {}: {e}", path.display())),
    }
}

#[tauri::command]
fn write_text(path: String, contents: String) -> Result<(), String> {
    let path = expand(&path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    fs::write(&path, contents).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

/// Directories the application generates and may therefore destroy.
///
/// Anything else — above all `analysis/`, which holds work the user and their
/// agents produced and which nothing here can reproduce — must be unreachable
/// from a recursive delete. Deleting the user's own work is the worst thing this
/// program could do, so the rule is enforced here rather than trusted to callers.
const DELETABLE: [&str; 1] = ["chapters"];

fn refuse_unless_generated(path: &Path) -> Result<(), String> {
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if !DELETABLE.contains(&name) {
        return Err(format!(
            "Refusing to delete {}: only {:?} are generated directories. \
             Everything else, including analysis/, belongs to you.",
            path.display(),
            DELETABLE,
        ));
    }
    Ok(())
}

/// Create `analysis/` and explain, in the folder itself, that it is the user's.
#[tauri::command]
fn ensure_analysis(dir: String) -> Result<String, String> {
    let analysis = expand(&dir).join("analysis");
    fs::create_dir_all(&analysis)
        .map_err(|e| format!("Cannot create {}: {e}", analysis.display()))?;
    let readme = analysis.join("README.md");
    if !readme.exists() {
        fs::write(&readme, ANALYSIS_README)
            .map_err(|e| format!("Cannot write {}: {e}", readme.display()))?;
    }
    Ok(analysis.to_string_lossy().into_owned())
}

const ANALYSIS_README: &str = "\
# analysis/

This folder is yours. Chapterize reads it and shows what is here beside the
chapter it belongs to. It never writes into it and never deletes from it — not
even when you re-split the book, which erases and rebuilds `../chapters/`.

Put anything here: summaries, diagrams, argument maps, NotebookLM exports, your
own notes. Markdown files are rendered in the app's Analysis tab.

A convention that makes files line up with chapters, though nothing enforces it:

    007-law-7-....summary.md      any name starting with the chapter number
    007-law-7-....diagram.md      is shown under that chapter
    reading-notes.md              anything else is shown under the book
";

/// Markdown files in `analysis/`, newest first, with sizes.
#[tauri::command]
fn list_analysis(dir: String) -> Result<Vec<AnalysisFile>, String> {
    let analysis = expand(&dir).join("analysis");
    if !analysis.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&analysis).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_markdown = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("md") || e.eq_ignore_ascii_case("markdown"));
        if !is_markdown {
            continue;
        }
        let meta = entry.metadata().map_err(|e| e.to_string())?;
        out.push(AnalysisFile {
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or_default().to_string(),
            path: path.to_string_lossy().into_owned(),
            size: meta.len(),
            modified: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
    }
    out.sort_by(|a, b| b.modified.cmp(&a.modified));
    Ok(out)
}

/// Write a book's chapter files into `dir/chapters`, replacing what is there.
///
/// The directory is emptied first so that re-splitting a book with different cut
/// points cannot leave orphaned files from the previous split lying around.
#[tauri::command]
fn write_chapters(dir: String, files: Vec<OutputFile>) -> Result<String, String> {
    let base = expand(&dir).join("chapters");
    refuse_unless_generated(&base)?;
    if base.exists() {
        fs::remove_dir_all(&base).map_err(|e| format!("Cannot clear {}: {e}", base.display()))?;
    }
    fs::create_dir_all(&base).map_err(|e| format!("Cannot create {}: {e}", base.display()))?;
    for file in files {
        if file.name.contains('/') || file.name.contains("..") {
            return Err(format!("Refusing to write suspicious filename: {}", file.name));
        }
        let path = base.join(&file.name);
        fs::write(&path, file.contents)
            .map_err(|e| format!("Cannot write {}: {e}", path.display()))?;
    }
    Ok(base.to_string_lossy().into_owned())
}

/// Write binary content — the figures pulled out of a book.
#[tauri::command]
fn write_bytes(path: String, contents: Vec<u8>) -> Result<(), String> {
    let path = expand(&path);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("Cannot create {}: {e}", parent.display()))?;
    }
    fs::write(&path, contents).map_err(|e| format!("Cannot write {}: {e}", path.display()))
}

/// Copy the original book in beside its chapters.
///
/// Copy, never move: the source is a file the user chose from anywhere on their
/// disk, and relocating it into an application-managed directory would make it
/// disappear from where they left it.
#[tauri::command]
fn copy_into(source: String, dir: String, name: String) -> Result<String, String> {
    let source = expand(&source);
    let target_dir = expand(&dir);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Cannot create {}: {e}", target_dir.display()))?;
    let target = target_dir.join(&name);

    // Copying a file onto itself truncates it to nothing, because the
    // destination is opened for truncation before the source is read. Re-splitting
    // a book in the library asks for exactly that, so refuse it here rather than
    // relying on every caller to remember.
    let same = match (source.canonicalize(), target.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    };
    if same {
        return Ok(target.to_string_lossy().into_owned());
    }

    fs::copy(&source, &target)
        .map_err(|e| format!("Cannot copy to {}: {e}", target.display()))?;
    Ok(target.to_string_lossy().into_owned())
}

/// Take a book out of the library without destroying it.
///
/// It moves to `.trash/` rather than being deleted. A book folder holds
/// `annotations.json` and `analysis/` — highlights the user wrote and work their
/// agents produced, none of which can be regenerated from the EPUB. Offering an
/// irreversible delete for that behind a single confirmation was a mistake; the
/// interface now removes immediately and offers Undo, which only works because
/// nothing is actually gone.
#[tauri::command]
fn remove_book(dir: String) -> Result<String, String> {
    let dir = expand(&dir);
    if !dir.join("index.json").exists() {
        return Err(format!("{} is not a Chapterize book; refusing to touch it.", dir.display()));
    }
    let library = dir
        .parent()
        .ok_or_else(|| "That book has no library folder.".to_string())?;
    let name = dir.file_name().and_then(|n| n.to_str()).unwrap_or("book");
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let trash = library.join(".trash");
    fs::create_dir_all(&trash).map_err(|e| format!("Cannot create {}: {e}", trash.display()))?;
    let target = trash.join(format!("{name}-{stamp}"));

    if fs::rename(&dir, &target).is_err() {
        copy_tree(&dir, &target)?;
        fs::remove_dir_all(&dir).map_err(|e| format!("Copied aside but could not clear the original: {e}"))?;
    }
    Ok(target.to_string_lossy().into_owned())
}

/// Put a book back where it came from.
#[tauri::command]
fn restore_book(trashed: String, library: String) -> Result<(), String> {
    let trashed = expand(&trashed);
    let name = trashed
        .file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.rsplit_once('-').map(|(head, _)| head.to_string()))
        .ok_or_else(|| "That is not something this removed.".to_string())?;
    let target = expand(&library).join(name);
    fs::rename(&trashed, &target).map_err(|e| format!("Could not put it back: {e}"))
}

/// Recursive copy, for when the trash lands on another filesystem.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|e| format!("Cannot create {}: {e}", to.display()))?;
    for entry in fs::read_dir(from).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let src = entry.path();
        let dst = to.join(entry.file_name());
        if src.is_dir() {
            copy_tree(&src, &dst)?;
        } else {
            fs::copy(&src, &dst).map_err(|e| format!("Cannot copy {}: {e}", src.display()))?;
        }
    }
    Ok(())
}

/// Sub-directories of the library that hold a parsed book.
#[tauri::command]
fn list_library(dir: String) -> Result<Vec<String>, String> {
    let dir = expand(&dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        if path.file_name().and_then(|n| n.to_str()) == Some(".trash") {
            continue;
        }
        if path.is_dir() && path.join("index.json").exists() {
            out.push(path.to_string_lossy().into_owned());
        }
    }
    out.sort();
    Ok(out)
}

/// Books handed to the app on the command line — by the file manager opening an
/// EPUB, or by a second launch while one is already running.
#[derive(Default)]
struct PendingFiles(Mutex<Vec<String>>);

/// EPUB paths in an argument list, ignoring the binary name and any flags.
fn epubs_from_args<I: IntoIterator<Item = String>>(args: I) -> Vec<String> {
    args.into_iter()
        .skip(1)
        .filter(|a| !a.starts_with('-'))
        .filter(|a| a.to_lowercase().ends_with(".epub"))
        .collect()
}

/// Hand over anything queued and clear it, so files are imported exactly once.
#[tauri::command]
fn pending_files(state: tauri::State<'_, PendingFiles>) -> Vec<String> {
    state
        .0
        .lock()
        .map(|mut queue| std::mem::take(&mut *queue))
        .unwrap_or_default()
}

/// The speech process currently running, so it can actually be stopped.
///
/// `spd-say --cancel` silences the queue but leaves a `--wait` invocation alive,
/// which would keep "speaking" true forever. The child is tracked and killed.
#[derive(Default)]
struct Speech(Mutex<Option<std::process::Child>>);

/// Read text aloud through the operating system.
///
/// WebKitGTK ships no Web Speech API, so `speechSynthesis` is simply absent and
/// a browser-based reader is silent with no error. The platform speech services
/// are used instead: speech-dispatcher on Linux, `say` on macOS.
#[tauri::command]
fn speak(text: String, state: tauri::State<'_, Speech>) -> Result<(), String> {
    stop_speaking(state.clone())?;

    // Passed as an argument, never through a shell, so book text cannot be
    // interpreted as a command however it is punctuated.
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut c = std::process::Command::new("spd-say");
        c.arg("--wait").arg("--").arg(&text);
        c
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut c = std::process::Command::new("say");
        c.arg("--").arg(&text);
        c
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let mut command = std::process::Command::new("cmd");

    let child = command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|e| format!(
            "Could not start speech: {e}. On Linux install speech-dispatcher and a voice such as espeak-ng."
        ))?;

    if let Ok(mut slot) = state.0.lock() {
        *slot = Some(child);
    }
    Ok(())
}

#[tauri::command]
fn stop_speaking(state: tauri::State<'_, Speech>) -> Result<(), String> {
    // Cancel what is queued, then end the process that is waiting on it.
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("spd-say")
        .arg("--cancel")
        .stdout(std::process::Stdio::null())
        .status();

    if let Ok(mut slot) = state.0.lock() {
        if let Some(mut child) = slot.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    Ok(())
}

#[tauri::command]
fn speech_available() -> bool {
    let program = if cfg!(target_os = "macos") { "say" } else { "spd-say" };
    std::process::Command::new("which")
        .arg(program)
        .stdout(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Amazon pages the app drives, in a window it owns.
const AMAZON_UPLOADER: &str = "https://www.amazon.com/sendtokindle";
const KINDLE_WINDOW: &str = "kindle";

/// Is there an Amazon session in the app's own webview?
///
/// The cookie jar is the app's, persisted under its data directory, so signing in
/// once behaves the way it does in the Kindle app rather than expiring with the
/// window.
#[tauri::command]
async fn kindle_connected(app: tauri::AppHandle) -> bool {
    let Ok(url) = AMAZON_UPLOADER.parse() else { return false };
    let Some(window) = app.get_webview_window(KINDLE_WINDOW) else {
        // No window yet: fall back to any webview's jar, which is shared.
        return app
            .webview_windows()
            .values()
            .next()
            .and_then(|w| w.cookies_for_url(url).ok())
            .map(|c| c.iter().any(|c| c.name() == "session-id" || c.name().starts_with("x-main")))
            .unwrap_or(false);
    };
    window
        .cookies_for_url(url)
        .map(|c| c.iter().any(|c| c.name() == "session-id" || c.name().starts_with("x-main")))
        .unwrap_or(false)
}

/// Open Amazon in a window belonging to the app, reusing it if already open.
#[tauri::command]
async fn open_kindle_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(existing) = app.get_webview_window(KINDLE_WINDOW) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    tauri::WebviewWindowBuilder::new(
        &app,
        KINDLE_WINDOW,
        tauri::WebviewUrl::External(AMAZON_UPLOADER.parse().map_err(|e| format!("{e}"))?),
    )
    .title("Kindle — sign in to Amazon")
    .inner_size(1000.0, 780.0)
    .build()
    .map(|_| ())
    .map_err(|e| format!("Could not open the Amazon window: {e}"))
}

/// Put a whole book on the Kindle through the app's signed-in Amazon window.
///
/// Amazon's uploader has no file input at all — it listens for drops — so the
/// file is handed over as a synthetic drop carrying a File built in the page.
/// The script reports back through the document title, because Tauri does not
/// expose its IPC to remote origins and this needs no dangerous settings.
#[tauri::command]
async fn send_via_amazon(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let file = expand(&path);
    let bytes = fs::read(&file).map_err(|e| format!("Cannot read {}: {e}", file.display()))?;
    let name = file.file_name().and_then(|n| n.to_str()).unwrap_or("book.epub").to_string();
    if name.contains('"') || name.contains('\\') {
        return Err(format!("Refusing to send a file with quotes in its name: {name}"));
    }
    let encoded = BASE64.encode(&bytes);

    open_kindle_window(app.clone()).await?;
    let window = app
        .get_webview_window(KINDLE_WINDOW)
        .ok_or_else(|| "The Amazon window did not open.".to_string())?;

    let script = format!(
        r#"(async () => {{
          const done = m => {{ document.title = m; }};
          try {{
            if (/\/ap\/signin/.test(location.pathname)) return done('CHZ:SIGNIN');
            if (!/sendtokindle/.test(location.href)) {{
              location.href = '{url}';
              return done('CHZ:NAVIGATING');
            }}
            let zone = null;
            for (let i = 0; i < 40 && !zone; i++) {{
              zone = document.querySelector('.s2k-dnd-home-wrapper');
              if (!zone) await new Promise(r => setTimeout(r, 250));
            }}
            if (!zone) return done('CHZ:ERR:Amazon changed their upload page');

            const bin = atob("{data}");
            const buf = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const file = new File([buf], "{name}", {{ type: 'application/epub+zip' }});
            const dt = new DataTransfer();
            dt.items.add(file);
            const opts = {{ bubbles: true, cancelable: true, dataTransfer: dt }};
            for (const t of [zone, document.body, document]) {{
              t.dispatchEvent(new DragEvent('dragenter', opts));
              t.dispatchEvent(new DragEvent('dragover', opts));
              t.dispatchEvent(new DragEvent('drop', opts));
            }}
            done('CHZ:SENT');
          }} catch (e) {{ done('CHZ:ERR:' + (e && e.message ? e.message : e)); }}
        }})();"#,
        url = AMAZON_UPLOADER,
        data = encoded,
        name = name,
    );

    window.eval(&script).map_err(|e| format!("Could not reach the Amazon window: {e}"))?;

    // The page answers through its title; poll rather than guess at a delay.
    for _ in 0..80 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        let title = window.title().unwrap_or_default();
        if let Some(rest) = title.strip_prefix("CHZ:") {
            return match rest {
                "SENT" => Ok(format!("{name} handed to Amazon — it appears on your devices shortly.")),
                "SIGNIN" => Err("Sign in to Amazon in the window that just opened, then send again.".into()),
                "NAVIGATING" => Err("Amazon was on another page; try again now that it has loaded.".into()),
                other => Err(other.trim_start_matches("ERR:").to_string()),
            };
        }
    }
    Err("Amazon did not respond. Check the window that opened.".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // Must be registered first. Opening a second book should reach the window
        // that is already open rather than start a rival copy of the library.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            let files = epubs_from_args(argv);
            if !files.is_empty() {
                if let Ok(mut queue) = app.state::<PendingFiles>().0.lock() {
                    queue.extend(files);
                }
                let _ = app.emit("files-opened", ());
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .manage(PendingFiles(Mutex::new(epubs_from_args(std::env::args()))))
        .manage(Speech::default())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            app_dirs,
            read_file,
            read_text,
            write_text,
            write_bytes,
            write_chapters,
            ensure_analysis,
            list_analysis,
            kindle_connected,
            open_kindle_window,
            send_via_amazon,
            speak,
            stop_speaking,
            speech_available,
            copy_into,
            remove_book,
            restore_book,
            list_library,
            pending_files,
        ])
        .run(tauri::generate_context!())
        .expect("error while running chapterize");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Copying a file onto itself used to truncate it to zero bytes, which
    /// destroyed the library's copy of a book whenever it was re-split.
    #[test]
    fn copy_into_refuses_to_copy_a_file_onto_itself() {
        let dir = std::env::temp_dir().join(format!("chapterize-selfcopy-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let book = dir.join("book.epub");
        fs::write(&book, b"PK\x03\x04 pretend archive").unwrap();

        let result = copy_into(
            book.to_string_lossy().into_owned(),
            dir.to_string_lossy().into_owned(),
            "book.epub".to_string(),
        );

        assert!(result.is_ok(), "same-file copy should be a no-op, not an error");
        assert_eq!(
            fs::read(&book).unwrap(),
            b"PK\x03\x04 pretend archive",
            "the file must still hold its original bytes"
        );
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn copy_into_still_copies_between_distinct_paths() {
        let dir = std::env::temp_dir().join(format!("chapterize-copy-{}", std::process::id()));
        let target = dir.join("library");
        fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.epub");
        fs::write(&source, b"contents").unwrap();

        copy_into(
            source.to_string_lossy().into_owned(),
            target.to_string_lossy().into_owned(),
            "book.epub".to_string(),
        )
        .unwrap();

        assert_eq!(fs::read(target.join("book.epub")).unwrap(), b"contents");
        fs::remove_dir_all(&dir).ok();
    }

    /// The single most destructive thing this program could do is delete work
    /// the user cannot reproduce. `analysis/` holds exactly that.
    #[test]
    fn analysis_is_never_deletable() {
        let dir = std::env::temp_dir().join(format!("chapterize-analysis-{}", std::process::id()));
        for name in ["analysis", "notes", "..", "book.epub", ""] {
            let target = dir.join(name);
            assert!(
                refuse_unless_generated(&target).is_err(),
                "{name:?} must not be deletable"
            );
        }
        assert!(refuse_unless_generated(&dir.join("chapters")).is_ok());
    }

    /// Re-splitting erases and rebuilds chapters/. It must not reach sideways.
    #[test]
    fn write_chapters_leaves_analysis_untouched() {
        let dir = std::env::temp_dir().join(format!("chapterize-resplit-{}", std::process::id()));
        let analysis = dir.join("analysis");
        fs::create_dir_all(&analysis).unwrap();
        let precious = analysis.join("summary.md");
        fs::write(&precious, b"an agent wrote this and nothing can regenerate it").unwrap();
        fs::create_dir_all(dir.join("chapters")).unwrap();
        fs::write(dir.join("chapters").join("stale.md"), b"old").unwrap();

        write_chapters(
            dir.to_string_lossy().into_owned(),
            vec![OutputFile { name: "001-new.md".into(), contents: "fresh".into() }],
        )
        .unwrap();

        assert_eq!(
            fs::read_to_string(&precious).unwrap(),
            "an agent wrote this and nothing can regenerate it"
        );
        assert!(!dir.join("chapters").join("stale.md").exists(), "chapters/ is rebuilt");
        assert!(dir.join("chapters").join("001-new.md").exists());
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn ensure_analysis_is_idempotent_and_never_clobbers() {
        let dir = std::env::temp_dir().join(format!("chapterize-ensure-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        ensure_analysis(dir.to_string_lossy().into_owned()).unwrap();

        let readme = dir.join("analysis").join("README.md");
        fs::write(&readme, b"user edited this").unwrap();
        ensure_analysis(dir.to_string_lossy().into_owned()).unwrap();

        assert_eq!(fs::read_to_string(&readme).unwrap(), "user edited this");
        fs::remove_dir_all(&dir).ok();
    }

    /// Removing a book must not destroy the one thing that cannot be rebuilt.
    #[test]
    fn removing_a_book_keeps_annotations_and_analysis() {
        let lib = std::env::temp_dir().join(format!("chapterize-rm-{}", std::process::id()));
        let book = lib.join("Some Book");
        fs::create_dir_all(book.join("analysis")).unwrap();
        fs::write(book.join("index.json"), b"{}").unwrap();
        fs::write(book.join("annotations.json"), b"[{\"quote\":\"mine\"}]").unwrap();
        fs::write(book.join("analysis").join("summary.md"), b"an agent wrote this").unwrap();

        let moved = remove_book(book.to_string_lossy().into_owned()).unwrap();

        assert!(!book.exists(), "it leaves the library");
        let moved = std::path::PathBuf::from(&moved);
        assert_eq!(fs::read_to_string(moved.join("annotations.json")).unwrap(), "[{\"quote\":\"mine\"}]");
        assert_eq!(fs::read_to_string(moved.join("analysis").join("summary.md")).unwrap(), "an agent wrote this");

        restore_book(moved.to_string_lossy().into_owned(), lib.to_string_lossy().into_owned()).unwrap();
        assert!(book.join("analysis").join("summary.md").exists(), "and it comes back");
        fs::remove_dir_all(&lib).ok();
    }

    #[test]
    fn only_epub_arguments_are_treated_as_books() {
        let args = vec![
            "/usr/bin/chapterize".to_string(),
            "--flag".to_string(),
            "/books/one.EPUB".to_string(),
            "/tmp/notes.txt".to_string(),
        ];
        assert_eq!(epubs_from_args(args), vec!["/books/one.EPUB".to_string()]);
    }
}
