//! Native side of Chapterize.
//!
//! Deliberately thin: all EPUB logic lives in TypeScript so it can be tested in
//! Node and reused by any other front end. Rust owns only what a webview cannot
//! do — reading arbitrary files, writing a library folder, and moving the
//! original book out of the inbox.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager};

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

/// Write a book's chapter files into `dir/chapters`, replacing what is there.
///
/// The directory is emptied first so that re-splitting a book with different cut
/// points cannot leave orphaned files from the previous split lying around.
#[tauri::command]
fn write_chapters(dir: String, files: Vec<OutputFile>) -> Result<String, String> {
    let base = expand(&dir).join("chapters");
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
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            app_dirs,
            read_file,
            read_text,
            write_text,
            write_bytes,
            write_chapters,
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
