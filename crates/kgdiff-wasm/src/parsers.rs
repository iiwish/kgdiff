//! The exports of `formats.wasm`: the graph file parsers, with options and results as JSON text.

use kgdiff_core::js::{Value, json};
use kgdiff_formats::{
    CompactWith, DocumentLoader, FormatId, JsonFields, LoadedDocument, ParseOptions, RdfOptions,
    compact_iri, detect_format, parse_graph,
};
use wasm_bindgen::prelude::*;

use crate::failure::{Failure, Result, thrown};

/// `text` read as JSON, or `None` when empty or `null`.
fn parsed(text: &str, what: &str) -> Result<Option<Value>> {
    if text.is_empty() {
        return Ok(None);
    }
    let value = json::parse(text)
        .map_err(|e| Failure::invalid_input(format!("{what} is not JSON: {e}")))?;
    Ok(Some(value).filter(|v| !v.is_null()))
}

fn string(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn strings(value: &Value, key: &str) -> Option<Vec<String>> {
    let list = value.get(key)?.as_array()?;
    Some(
        list.iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect(),
    )
}

fn pairs(value: Option<&Value>) -> Option<Vec<(String, String)>> {
    let object = value?.as_object()?;
    Some(
        object
            .iter()
            .filter_map(|(key, v)| v.as_str().map(|v| (key.as_str().to_owned(), v.to_owned())))
            .collect(),
    )
}

fn flag(value: &Value, key: &str, default: bool) -> bool {
    match value.get(key) {
        Some(Value::Bool(b)) => *b,
        _ => default,
    }
}

fn rdf_options(value: Option<&Value>) -> RdfOptions {
    let defaults = RdfOptions::default();
    let Some(value) = value else {
        return defaults;
    };
    RdfOptions {
        label_predicates: strings(value, "labelPredicates"),
        alias_predicates: strings(value, "aliasPredicates"),
        type_edges: flag(value, "typeEdges", defaults.type_edges),
        owl_restrictions: flag(value, "owlRestrictions", defaults.owl_restrictions),
        languages: strings(value, "languages"),
        prefixes: pairs(value.get("prefixes")),
        compact_with: match value.get("compactWith").and_then(Value::as_str) {
            Some("declared") => CompactWith::Declared,
            _ => CompactWith::WellKnown,
        },
        fold_annotations: flag(value, "foldAnnotations", defaults.fold_annotations),
    }
}

fn json_fields(value: Option<&Value>) -> JsonFields {
    let Some(fields) = value.and_then(|v| v.get("fields")) else {
        return JsonFields::default();
    };
    JsonFields {
        id: string(fields, "id"),
        label: string(fields, "label"),
        r#type: string(fields, "type"),
        source: string(fields, "source"),
        target: string(fields, "target"),
        predicate: string(fields, "predicate"),
    }
}

/// `parseGraph(text, options)`, without `jsonld.documentLoader`, which is `loader` here.
fn parse(text: &str, options_text: &str, loader: Option<&DocumentLoader>) -> Result<String> {
    let value = parsed(options_text, "the parse options")?.unwrap_or_default();
    let format = match value.get("format").and_then(Value::as_str) {
        None | Some("auto") => None,
        Some(id) => Some(FormatId::from_id(id).ok_or_else(|| {
            Failure::invalid_input(format!(
                "Unknown format \"{id}\". Expected auto, {}.",
                kgdiff_formats::FORMAT_EXTENSIONS
                    .iter()
                    .map(|(format, _)| format.id())
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })?),
    };
    let options = ParseOptions {
        format,
        filename: string(&value, "filename"),
        base_iri: string(&value, "baseIRI"),
        rdf: rdf_options(value.get("rdf")),
        json: json_fields(value.get("json")),
        document_loader: loader,
    };
    let result = parse_graph(text, &options)?;
    Ok(json::to_string(&result.to_value()))
}

/// `parseGraph(text, options)`: the options and the `ParseResult` as JSON text. `loader`, when
/// given, is `jsonld.documentLoader`: it gets a URL and returns the context as JSON text, or
/// `undefined`.
#[wasm_bindgen(js_name = parseGraphJSON)]
pub fn parse_graph_json(
    text: &str,
    options: &str,
    loader: Option<js_sys::Function>,
) -> std::result::Result<String, JsValue> {
    let call = loader.map(|loader| {
        move |url: &str| -> std::result::Result<Option<LoadedDocument>, String> {
            let returned = loader
                .call1(&JsValue::NULL, &JsValue::from_str(url))
                .map_err(|e| e.as_string().unwrap_or_else(|| "failed".to_owned()))?;
            Ok(returned.as_string().map(LoadedDocument::Text))
        }
    });
    thrown(parse(
        text,
        options,
        call.as_ref().map(|c| c as &DocumentLoader),
    ))
}

/// `detectFormat(text, filename)`.
#[wasm_bindgen(js_name = detectFormat)]
pub fn detect(text: &str, filename: Option<String>) -> std::result::Result<String, JsValue> {
    thrown(
        detect_format(text, filename.as_deref())
            .map(|format| format.id().to_owned())
            .map_err(Failure::from),
    )
}

/// `compactIri(iri, prefixes)`, `prefixes` a JSON object or empty.
#[wasm_bindgen(js_name = compactIri)]
pub fn compact(iri: &str, prefixes: &str) -> std::result::Result<String, JsValue> {
    thrown(parsed(prefixes, "the prefixes").map(|value| {
        let prefixes = pairs(value.as_ref());
        compact_iri(iri, prefixes.as_deref())
    }))
}
