//! `cargo run -p kgdiff-formats --example parse -- <file> [format]`: prints the `ParseResult`.
fn main() {
    let mut args = std::env::args().skip(1);
    let path = args.next().expect("a file");
    let text = std::fs::read_to_string(&path).expect("readable UTF-8");
    let format = args
        .next()
        .and_then(|f| kgdiff_formats::FormatId::from_id(&f));
    let filename = std::path::Path::new(&path)
        .file_name()
        .map(|f| f.to_string_lossy().into_owned());
    let mut options = kgdiff_formats::ParseOptions::default();
    options.format = format;
    options.filename = filename;
    match kgdiff_formats::parse_graph(&text, &options) {
        Ok(result) => println!("{}", kgdiff_core::js::json::to_string(&result.to_value())),
        Err(error) => println!("ERROR {} {}", error.code, error.message),
    }
}
