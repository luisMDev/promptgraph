//! Native questions of the shell (DESIGN §20.8–§20.10): a plain-text GTK message dialog on the main thread,
//! answered over a channel to the waiting worker thread. No dialog plugin: it would inject window.alert and
//! window.confirm into the daemon's page.

use std::cell::Cell;
use std::sync::{mpsc, Mutex, OnceLock};

use gtk::prelude::*;
use tauri::{AppHandle, Manager};

/// `PG_DESKTOP_AUTO_ANSWER=id=key,…`, read once at start (the variable never reaches a child).
static AUTO_ANSWERS: OnceLock<Vec<(String, String)>> = OnceLock::new();
/// One dialog at a time.
static ONE_AT_A_TIME: Mutex<()> = Mutex::new(());

pub fn init() {
    AUTO_ANSWERS.get_or_init(|| parse_answers(&std::env::var("PG_DESKTOP_AUTO_ANSWER").unwrap_or_default()));
}

fn parse_answers(value: &str) -> Vec<(String, String)> {
    value.split(',').filter_map(|pair| pair.split_once('=')).map(|(id, key)| (id.trim().into(), key.trim().into())).collect()
}

/// The answers given for question `id` (it may be listed twice: `version-mismatch=keep,version-mismatch=use`
/// covers an older and a newer daemon) and the index of the first one that is a button.
fn auto_answer<'a>(answers: &'a [(String, String)], id: &str, keys: &[&str]) -> (Vec<&'a str>, Option<usize>) {
    let given: Vec<&str> = answers.iter().filter(|(question, _)| question == id).map(|(_, key)| key.as_str()).collect();
    let index = given.iter().find_map(|key| keys.iter().position(|k| k == key));
    (given, index)
}

/// Text that did not come from the app (release notes, paths, versions) is shown as is: no markup, and no
/// control characters but newlines.
pub fn plain_text(text: &str) -> String {
    text.chars().filter(|c| *c == '\n' || !c.is_control()).collect()
}

/// Asks question `id` and returns the key of the button chosen, `default` when the dialog is closed (Escape,
/// close button), or None when it was never shown (no window, no main thread): callers must not record that
/// as an answer. Blocks the calling thread: never call it on the main thread.
pub fn ask<'a>(app: &AppHandle, id: &str, title: &str, text: &str, buttons: &[(&'a str, String)], default: usize) -> Option<&'a str> {
    debug_assert_ne!(std::thread::current().name(), Some("main"), "dialog::ask on the main thread");
    let key_at = |i: usize| buttons.get(i).or(buttons.get(default)).map_or("", |(key, _)| *key);
    let keys: Vec<&str> = buttons.iter().map(|(key, _)| *key).collect();
    let (given, auto) = auto_answer(AUTO_ANSWERS.get().map_or(&[], Vec::as_slice), id, &keys);
    if let Some(index) = auto {
        eprintln!("promptgraph-desktop: auto-answered {id}={}", key_at(index));
        return Some(key_at(index));
    }
    // A test run must not wait on a question nobody sees without saying why.
    if !given.is_empty() { eprintln!("promptgraph-desktop: auto-answer {id}={} is not a button ({}); asking", given.join("|"), keys.join(", ")); }
    let _one = ONE_AT_A_TIME.lock().unwrap_or_else(|e| e.into_inner());
    let (tx, rx) = mpsc::channel::<usize>();
    let (title, text) = (plain_text(title), plain_text(text));
    let labels: Vec<String> = buttons.iter().map(|(_, label)| plain_text(label)).collect();
    let kind = if buttons.len() > 1 { gtk::MessageType::Question } else { gtk::MessageType::Info };
    let handle = app.clone();
    let shown = app.run_on_main_thread(move || {
        // No window: `tx` is dropped and the caller gets None.
        let Some(parent) = handle.get_webview_window("main").and_then(|w| w.gtk_window().ok()) else { return };
        let dialog = gtk::MessageDialog::builder()
            .transient_for(&parent).modal(true).destroy_with_parent(true).message_type(kind)
            .title("promptgraph").text(title).secondary_text(text)
            .use_markup(false).secondary_use_markup(false)
            .build();
        for (i, label) in labels.iter().enumerate() {
            dialog.add_button(label, gtk::ResponseType::Other(i as u16));
        }
        dialog.set_default_response(gtk::ResponseType::Other(default as u16));
        // Escape or the close button answer DeleteEvent: the default. A dialog destroyed with its parent
        // without a response drops `tx`.
        let tx = Cell::new(Some(tx));
        dialog.connect_response(move |dialog, response| {
            let chosen = if let gtk::ResponseType::Other(i) = response { usize::from(i) } else { default };
            if let Some(tx) = tx.take() { let _ = tx.send(chosen); }
            // DeleteEvent already destroys the dialog.
            if matches!(response, gtk::ResponseType::Other(_)) { dialog.close(); }
        });
        dialog.show_all();
    });
    shown.ok().and_then(|()| rx.recv().ok()).map(key_at)
}

#[cfg(test)]
mod tests {
    use super::{auto_answer, parse_answers, plain_text};

    #[test]
    fn picks_the_first_auto_answer_that_is_a_button() {
        let answers = parse_answers("update=later,version-mismatch=keep,version-mismatch=use");
        // An older daemon (restart, keep) and a newer one (use, restart) are both answered.
        assert_eq!(auto_answer(&answers, "version-mismatch", &["restart", "keep"]).1, Some(1));
        assert_eq!(auto_answer(&answers, "version-mismatch", &["use", "restart"]).1, Some(0));
        assert_eq!(auto_answer(&answers, "update", &["update", "later"]).1, Some(1));
        assert_eq!(auto_answer(&answers, "shim-offer", &["install", "skip"]), (vec![], None));
        assert_eq!(auto_answer(&answers, "update", &["ok"]), (vec!["later"], None));
    }

    #[test]
    fn plain_text_drops_control_characters_but_newlines() {
        assert_eq!(plain_text("a\u{1b}[31mb\r\n\tc\u{7f}\u{9c}d"), "a[31mb\ncd");
        assert_eq!(plain_text("<b>notes</b> & more"), "<b>notes</b> & more");
    }

    #[test]
    fn parses_auto_answers() {
        assert_eq!(
            parse_answers("shim-offer=install, version-mismatch=restart,bad"),
            vec![("shim-offer".into(), "install".into()), ("version-mismatch".into(), "restart".into())]
        );
        assert!(parse_answers("").is_empty());
    }
}
