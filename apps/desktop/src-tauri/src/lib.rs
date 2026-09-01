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

/// Delete one book folder. Refuses anything that is not a book, so a mistyped
/// path cannot take a directory tree with it.
#[tauri::command]
fn remove_book(dir: String) -> Result<(), String> {
    let dir = expand(&dir);
    if !dir.join("index.json").exists() {
        return Err(format!("{} is not a Chapterize book; refusing to delete it.", dir.display()));
    }
    fs::remove_dir_all(&dir).map_err(|e| format!("Cannot delete {}: {e}", dir.display()))
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

/// Where the Send-to-Kindle app password lives: the OS keyring, never a file.
const KEYRING_SERVICE: &str = "dev.l11.chapterize";
const KEYRING_USER: &str = "smtp-app-password";

#[derive(Deserialize)]
pub struct KindleConfig {
    /// The @kindle.com address of the device to deliver to.
    to: String,
    /// The sender, which must be on Amazon's Approved Personal Document list.
    from: String,
    /// e.g. "smtp.gmail.com".
    host: String,
    port: u16,
}

/// Store the app password in the OS keyring. It never touches settings or disk.
#[tauri::command]
fn save_kindle_password(password: String) -> Result<(), String> {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|e| e.set_password(&password))
        .map_err(|e| format!("Could not save to the system keyring: {e}"))
}

#[tauri::command]
fn has_kindle_password() -> bool {
    keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|e| e.get_password())
        .is_ok()
}

#[tauri::command]
fn forget_kindle_password() -> Result<(), String> {
    match keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).and_then(|e| e.delete_credential()) {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("Could not clear the keyring entry: {e}")),
    }
}

/// Mail the whole book to a Kindle device.
///
/// Whole book only, never chapters: Amazon converts one file into one library
/// entry, so fifty chapters would arrive as fifty unrelated "books". Chapters
/// stay on this machine, which is what they are for.
#[tauri::command]
fn send_to_kindle(path: String, config: KindleConfig) -> Result<String, String> {
    use lettre::message::{header::ContentType, Attachment, MultiPart, SinglePart};
    use lettre::transport::smtp::authentication::Credentials;
    use lettre::{Message, SmtpTransport, Transport};

    let file = expand(&path);
    let bytes = fs::read(&file).map_err(|e| format!("Cannot read {}: {e}", file.display()))?;
    // Amazon rejects personal documents above 50 MB; mail servers usually stop
    // sooner. Fail here with a clear reason rather than after a long upload.
    if bytes.len() > 25 * 1024 * 1024 {
        return Err(format!(
            "{:.1} MB is too large to e-mail. Use the web uploader instead, which accepts up to 200 MB.",
            bytes.len() as f64 / 1_048_576.0
        ));
    }
    let name = file
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("book.epub")
        .to_string();

    let password = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER)
        .and_then(|e| e.get_password())
        .map_err(|_| "No app password saved. Add one in Kindle settings.".to_string())?;

    let attachment = Attachment::new(name.clone()).body(
        bytes,
        ContentType::parse("application/epub+zip").map_err(|e| e.to_string())?,
    );

    let email = Message::builder()
        .from(config.from.parse().map_err(|e| format!("Bad sender address: {e}"))?)
        .to(config.to.parse().map_err(|e| format!("Bad Kindle address: {e}"))?)
        // Amazon ignores the subject for EPUB personal documents, but a blank
        // one makes the message look like spam to intermediate relays.
        .subject("Convert")
        .multipart(MultiPart::mixed().singlepart(SinglePart::plain(String::new())).singlepart(attachment))
        .map_err(|e| format!("Could not build the message: {e}"))?;

    let creds = Credentials::new(config.from.clone(), password);
    let mailer = SmtpTransport::starttls_relay(&config.host)
        .map_err(|e| format!("Cannot reach {}: {e}", config.host))?
        .port(config.port)
        .credentials(creds)
        .build();

    mailer
        .send(&email)
        .map(|_| format!("Sent {name} to {}", config.to))
        .map_err(|e| format!("Send failed: {e}. Check the app password, and that the sender is on Amazon's Approved Personal Document list."))
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
            save_kindle_password,
            has_kindle_password,
            forget_kindle_password,
            send_to_kindle,
            speak,
            stop_speaking,
            speech_available,
            copy_into,
            remove_book,
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
