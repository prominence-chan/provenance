//! Embeds every file under `prompts/` so harness.toml can name one with
//! `instructions_file = "<name>"` without a code change.

use std::fmt::Write as _;
use std::path::Path;

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("prompts");
    println!("cargo:rerun-if-changed={}", dir.display());
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map(|entries| {
            entries
                .filter_map(Result::ok)
                .filter(|entry| entry.path().is_file())
                .filter_map(|entry| entry.file_name().into_string().ok())
                .collect()
        })
        .unwrap_or_default();
    names.sort();

    let mut out = String::from("/// Files under codex-rs/provenance/prompts/, by file name.\n");
    out.push_str("pub const PROMPT_FILES: &[(&str, &str)] = &[\n");
    for name in &names {
        let path = dir.join(name);
        println!("cargo:rerun-if-changed={}", path.display());
        let _ = writeln!(
            out,
            "    ({name:?}, include_str!({:?})),",
            path.display().to_string()
        );
    }
    out.push_str("];\n");

    let out_dir = std::env::var("OUT_DIR").unwrap_or_else(|err| panic!("OUT_DIR: {err}"));
    std::fs::write(Path::new(&out_dir).join("prompts.rs"), out)
        .unwrap_or_else(|err| panic!("write prompts.rs: {err}"));
}
