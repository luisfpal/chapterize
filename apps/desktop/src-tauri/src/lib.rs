//! Native side of Chapterize.
//!
//! Deliberately thin: all EPUB logic lives in TypeScript so it can be tested in
//! Node and reused by any other front end. Rust owns only what a webview cannot
//! do — reading arbitrary files, writing a library folder, and moving the
//! original book out of the inbox.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct InboxEntry {
    path: String,
    name: String,
    size: u64,
}

#[derive(Deserialize)]
pub struct OutputFile {
    name: String,
    contents: String,
}

fn expand(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

/// EPUBs sitting in a directory, newest first. Non-recursive on purpose: an
/// inbox is a flat drop zone, and recursing would sweep up a whole library.
#[tauri::command]
fn list_epubs(dir: String) -> Result<Vec<InboxEntry>, String> {
    let dir = expand(&dir);
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| format!("Cannot read {}: {e}", dir.display()))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let is_epub = path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| e.eq_ignore_ascii_case("epub"));
        if !is_epub {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        out.push(InboxEntry {
            name: path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_string(),
            path: path.to_string_lossy().into_owned(),
            size,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
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

/// Move the original book next to its chapters.
///
/// Falls back to copy-then-delete because a rename across filesystems fails, and
/// an inbox on a different mount from the library is an ordinary setup.
#[tauri::command]
fn move_into(source: String, dir: String, name: String) -> Result<String, String> {
    let source = expand(&source);
    let target_dir = expand(&dir);
    fs::create_dir_all(&target_dir)
        .map_err(|e| format!("Cannot create {}: {e}", target_dir.display()))?;
    let target = target_dir.join(&name);

    if fs::rename(&source, &target).is_err() {
        fs::copy(&source, &target)
            .map_err(|e| format!("Cannot copy to {}: {e}", target.display()))?;
        fs::remove_file(&source)
            .map_err(|e| format!("Copied to {} but could not remove the original: {e}", target.display()))?;
    }
    Ok(target.to_string_lossy().into_owned())
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

#[tauri::command]
fn home_dir() -> String {
    std::env::var("HOME").unwrap_or_else(|_| String::from("/"))
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    Path::new(&expand(&path)).exists()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            list_epubs,
            read_file,
            read_text,
            write_text,
            write_chapters,
            move_into,
            list_library,
            home_dir,
            path_exists,
        ])
        .run(tauri::generate_context!())
        .expect("error while running chapterize");
}
