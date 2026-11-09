//! Feature `embed-viewer`: embed the viewer bundles that `pnpm build:viewer-assets` copies into
//! `assets/` (RFC 0002, §8, "Build order"). Without them the crate still builds, with a warning,
//! and `embedded_viewer()` returns `None`, so `kgdiff -o` can name the missing step.

use std::path::Path;

const BUNDLES: [&str; 2] = ["kgdiff-viewer.js", "kgdiff-viewer-compute.js"];

fn main() {
    println!("cargo::rustc-check-cfg=cfg(kgdiff_viewer)");
    println!("cargo::rerun-if-env-changed=CARGO_FEATURE_EMBED_VIEWER");
    for bundle in BUNDLES {
        println!("cargo::rerun-if-changed=assets/{bundle}");
    }
    if std::env::var_os("CARGO_FEATURE_EMBED_VIEWER").is_none() {
        return;
    }
    let missing: Vec<&str> = BUNDLES
        .into_iter()
        .filter(|b| !Path::new("assets").join(b).is_file())
        .collect();
    if missing.is_empty() {
        println!("cargo::rustc-cfg=kgdiff_viewer");
    } else {
        println!(
            "cargo::warning=the viewer bundles are missing ({}): run `pnpm build:viewer-assets` to embed them; HTML reports fail until then",
            missing.join(", ")
        );
    }
}
