//! JSON-LD 1.1 → RDF quads, synchronously (`jsonld.ts`, ported as it is; RFC 0002, D-9):
//! context processing, expansion and deserialization to RDF (JSON-LD 1.1 Processing
//! Algorithms and API §4, §5, §8), with kgdiff's choices — contexts inline or from the
//! caller's synchronous document loader, relative IRIs kept without a base, `@direction` not
//! represented, keys without a mapping dropped and reported, nesting limited to 200 levels.

use std::rc::Rc;

use kgdiff_core::KgdiffError;
use kgdiff_core::js::{self, IndexMap, IndexSet, JsStr, Lookup, Object, Value, json};
use kgdiff_core::text::to_lowercase;

use crate::iri::{is_absolute_iri, resolve_iri};
use crate::json::{JsonTextError, parse_deep_json};
use crate::prefixes::{RDF_NS, XSD_NS};
use crate::rdf::RdfDocument;
use crate::shared::{
    Warnings, canonical_json, compare_strings, invalid_input_with, plural, slice_utf16,
};
use crate::term::{Literal, LiteralKind, Quad, Term};
use crate::{DocumentLoader, LoadedDocument, ParseWarningCode};

const KEYWORDS: &[&str] = &[
    "@base",
    "@container",
    "@context",
    "@direction",
    "@graph",
    "@id",
    "@import",
    "@included",
    "@index",
    "@json",
    "@language",
    "@list",
    "@nest",
    "@none",
    "@prefix",
    "@propagate",
    "@protected",
    "@reverse",
    "@set",
    "@type",
    "@value",
    "@version",
    "@vocab",
];

/// Context entries that are not term definitions.
const CONTEXT_KEYWORDS: &[&str] = &[
    "@base",
    "@direction",
    "@import",
    "@language",
    "@propagate",
    "@protected",
    "@version",
    "@vocab",
];

const TERM_DEFINITION_KEYS: &[&str] = &[
    "@id",
    "@reverse",
    "@container",
    "@context",
    "@direction",
    "@index",
    "@language",
    "@nest",
    "@prefix",
    "@protected",
    "@type",
];

const CONTAINERS: &[&str] = &[
    "@graph",
    "@id",
    "@index",
    "@language",
    "@list",
    "@set",
    "@type",
];

const VALUE_KEYS: &[&str] = &["@direction", "@index", "@language", "@type", "@value"];

/// Offending JSON values are quoted in messages up to this length.
const DETAIL_LENGTH: usize = 120;
/// More remote contexts than this in one chain is a `context overflow`.
const MAX_REMOTE_CONTEXTS: usize = 32;
/// The deepest nesting accepted.
pub const MAX_JSON_LD_NESTING: usize = 200;

fn is_keyword(value: &str) -> bool {
    KEYWORDS.contains(&value)
}

/// `/^@[a-zA-Z]+$/`: reserved for future keywords.
fn keyword_form(value: &str) -> bool {
    value
        .strip_prefix('@')
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphabetic()))
}

/// `/[:/?#[\]@]$/`: an IRI ending like this can serve as a prefix.
fn gen_delim_end(iri: &str) -> bool {
    iri.ends_with([':', '/', '?', '#', '[', ']', '@'])
}

/// `/^[a-zA-Z]{1,8}(?:-[a-zA-Z0-9]{1,8})*$/`.
fn language_tag(value: &str) -> bool {
    let mut parts = value.split('-');
    let first = parts.next().unwrap_or("");
    (1..=8).contains(&first.len())
        && first.bytes().all(|b| b.is_ascii_alphabetic())
        && parts.all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|b| b.is_ascii_alphanumeric()))
}

/// No characters RDF forbids, and at most one `#`.
fn well_formed_iri(iri: &str) -> bool {
    if iri.is_empty() || iri.find('#') != iri.rfind('#') {
        return false;
    }
    !iri.chars().any(|c| c <= ' ' || "<>\"{}|\\^`".contains(c))
}

/// `value.indexOf(':', 1)`.
fn colon_after_first(value: &str) -> Option<usize> {
    let first = value.chars().next()?.len_utf8();
    value[first..].find(':').map(|i| i + first)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Direction {
    Ltr,
    Rtl,
}

impl Direction {
    fn as_str(self) -> &'static str {
        match self {
            Direction::Ltr => "ltr",
            Direction::Rtl => "rtl",
        }
    }
}

/// A term definition. `None` is `undefined`; `Some(None)` is `null`.
#[derive(Clone, Debug, PartialEq)]
struct TermDefinition {
    /// IRI mapping: an IRI, a blank node id, a keyword, or `None` for a term that maps to nothing.
    iri: Option<String>,
    prefix: bool,
    protected: bool,
    reverse: bool,
    type_: Option<String>,
    language: Option<Option<String>>,
    direction: Option<Option<Direction>>,
    /// Container mapping, sorted.
    container: Vec<String>,
    index: Option<String>,
    nest: Option<String>,
    /// Scoped context and the base URL it was defined with.
    context: Option<Rc<Value>>,
    base_url: Option<String>,
}

impl TermDefinition {
    fn has_container(&self, name: &str) -> bool {
        self.container.iter().any(|c| c == name)
    }

    /// Whether two definitions are the same but for `protected` and the base URL
    /// (`sameDefinition`, which compares their canonical JSON).
    fn same(&self, other: &TermDefinition) -> bool {
        self.iri == other.iri
            && self.prefix == other.prefix
            && self.reverse == other.reverse
            && self.type_ == other.type_
            && self.language == other.language
            && self.direction == other.direction
            && self.container == other.container
            && self.index == other.index
            && self.nest == other.nest
            && self.context == other.context
    }
}

#[derive(Clone, Debug)]
struct Context {
    terms: IndexMap<String, Rc<TermDefinition>>,
    base: Option<String>,
    original_base: Option<String>,
    vocab: Option<String>,
    language: Option<String>,
    direction: Option<Direction>,
    /// The context to return to on new node objects, set by non-propagated contexts.
    previous: Option<Rc<Context>>,
}

/// Where term definitions are being created: the local context and its processing state.
struct Definitions {
    local: Object,
    defined: IndexMap<String, bool>,
    base_url: Option<String>,
    override_protected: bool,
    remote: Vec<String>,
}

/// Why reading stopped: a JSON-LD error (its code from the spec, and what it concerns) or
/// another kgdiff error.
enum LdError {
    Ld { code: &'static str, detail: String },
    Kgdiff(KgdiffError),
}

type Ld<T> = Result<T, LdError>;

/// `fail(code, detail)` with an explanation.
fn fail<T>(code: &'static str, detail: impl Into<String>) -> Ld<T> {
    Err(LdError::Ld {
        code,
        detail: detail.into(),
    })
}

/// `fail(code, value)` quoting a JSON value (cut at 120 units).
fn fail_value<T>(code: &'static str, value: &Value) -> Ld<T> {
    let text = json::to_string(value);
    let detail = if js::utf16_len(&text) > DETAIL_LENGTH {
        format!("{}…", slice_utf16(&text, DETAIL_LENGTH))
    } else {
        text
    };
    fail(code, detail)
}

fn is_map(value: &Value) -> bool {
    matches!(value, Value::Object(_))
}

fn arrayify(value: &Value) -> Vec<Value> {
    match value {
        Value::Array(items) => items.clone(),
        other => vec![other.clone()],
    }
}

fn is_scalar(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_))
}

fn has(value: &Value, key: &str) -> bool {
    value.as_object().is_some_and(|o| o.contains_key(key))
}

fn is_value_object(value: &Value) -> bool {
    has(value, "@value")
}

fn is_list_object(value: &Value) -> bool {
    has(value, "@list")
}

fn is_graph_object(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        o.contains_key("@graph")
            && o.keys()
                .all(|k| matches!(k.as_str(), "@graph" | "@id" | "@index"))
    })
}

fn is_node_object(value: &Value) -> bool {
    is_map(value) && !has(value, "@value") && !has(value, "@list") && !has(value, "@set")
}

fn get<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
    value.as_object().and_then(|o| o.get(key))
}

/// Appends values to `map[key]`, which always holds an array (`addValues`).
fn add_values(map: &mut Object, key: &str, values: Vec<Value>) {
    match map.get_mut(key) {
        Some(Value::Array(existing)) => existing.extend(values),
        Some(existing) => {
            let first = std::mem::take(existing);
            let mut all = vec![first];
            all.extend(values);
            *existing = Value::Array(all);
        }
        None => {
            map.insert(key, Value::Array(values));
        }
    }
}

/// Container mappings JSON-LD 1.1 allows (§4.2.2, step 21.1).
fn valid_container(container: &[String]) -> bool {
    let set: IndexSet<&str> = container.iter().map(String::as_str).collect();
    if set.len() != container.len() || !container.iter().all(|c| CONTAINERS.contains(&c.as_str())) {
        return false;
    }
    if container.len() == 1 {
        return true;
    }
    if set.contains("@list") {
        return false;
    }
    if set.contains("@graph") && (set.contains("@id") || set.contains("@index")) {
        return !(set.contains("@id") && set.contains("@index"))
            && container.iter().all(|c| c != "@type" && c != "@language");
    }
    set.contains("@set") && container.len() == 2
}

/// Reads a parsed JSON-LD document into quads (`readJsonLd`).
pub fn read_json_ld(
    document: &Value,
    base: Option<&str>,
    loader: Option<&DocumentLoader>,
    warnings: &mut Warnings,
) -> Result<RdfDocument, KgdiffError> {
    let mut reader = JsonLdReader {
        base: base.map(str::to_owned),
        loader,
        quads: Vec::new(),
        prefixes: IndexMap::default(),
        unmapped: IndexSet::default(),
        loaded: Lookup::new(),
        iris: Lookup::new(),
        blanks: 0,
    };
    match reader.read(document) {
        Ok(()) => {}
        Err(LdError::Kgdiff(error)) => return Err(error),
        Err(LdError::Ld { code, detail }) => {
            let mut details = Object::new();
            details.insert("format", "jsonld");
            details.insert("code", code);
            return Err(invalid_input_with(
                format!("Invalid JSON-LD: {code}: {detail}."),
                details,
            ));
        }
    }
    if !reader.unmapped.is_empty() {
        let mut keys: Vec<&String> = reader.unmapped.iter().collect();
        keys.sort_by(|a, b| compare_strings(a, b));
        let shown: Vec<String> = keys
            .iter()
            .take(5)
            .map(|key| {
                let mut s = String::new();
                json::push_string(&mut s, key);
                s
            })
            .collect();
        warnings.add(
            ParseWarningCode::JsonLdUnmappedTerms,
            format!(
                "Dropped {} that map to no IRI (no @context term or @vocab): {}{}.",
                plural(keys.len(), "JSON-LD key"),
                shown.join(", "),
                if keys.len() > shown.len() {
                    ", …"
                } else {
                    ""
                }
            ),
            None,
        );
    }
    Ok(RdfDocument {
        quads: reader.quads,
        prefixes: reader.prefixes.into_iter().collect(),
    })
}

struct JsonLdReader<'a> {
    base: Option<String>,
    loader: Option<&'a DocumentLoader>,
    quads: Vec<Quad>,
    prefixes: IndexMap<String, String>,
    /// Keys dropped because they expand to no IRI.
    unmapped: IndexSet<String>,
    /// `@context` of every remote document, by URL (loaded once per parse).
    loaded: Lookup<String, Value>,
    iris: Lookup<String, Rc<str>>,
    blanks: usize,
}

impl JsonLdReader<'_> {
    fn read(&mut self, document: &Value) -> Ld<()> {
        let initial = Rc::new(Context {
            terms: IndexMap::default(),
            base: self.base.clone(),
            original_base: self.base.clone(),
            vocab: None,
            language: None,
            direction: None,
            previous: None,
        });
        let base = self.base.clone();
        let mut expanded = self.expand(&initial, None, document, base.as_deref(), false, 0)?;
        if let Value::Object(o) = &expanded
            && o.len() == 1
            && o.contains_key("@graph")
        {
            expanded = o.get("@graph").cloned().unwrap_or(Value::Null);
        }
        for node in arrayify(&expanded) {
            if let Value::Object(node) = node {
                self.emit_node(&node, &Term::DefaultGraph);
            }
        }
        Ok(())
    }

    // ─── Context processing (§4.1) ──────────────────────────────────────────

    #[allow(clippy::too_many_arguments)]
    fn process_context(
        &mut self,
        active: &Rc<Context>,
        local: &Value,
        base_url: Option<&str>,
        remote: &[String],
        override_protected: bool,
        propagate_default: bool,
        validate_scoped: bool,
    ) -> Ld<Context> {
        let mut result: Context = (**active).clone();
        let mut propagate = propagate_default;
        if let Some(value) = get(local, "@propagate") {
            let Value::Bool(flag) = value else {
                return fail_value("invalid @propagate value", value);
            };
            propagate = *flag;
        }
        if !propagate && result.previous.is_none() {
            result.previous = Some(Rc::clone(active));
        }
        for context in arrayify(local) {
            match &context {
                Value::Null => {
                    if !override_protected && result.terms.values().any(|t| t.protected) {
                        return fail(
                            "invalid context nullification",
                            "a context with protected terms",
                        );
                    }
                    let previous = Rc::new(result);
                    result = Context {
                        terms: IndexMap::default(),
                        base: active.original_base.clone(),
                        original_base: active.original_base.clone(),
                        vocab: None,
                        language: None,
                        direction: None,
                        previous: if propagate { None } else { Some(previous) },
                    };
                    continue;
                }
                Value::String(reference) => {
                    let url = resolve_iri(reference, base_url);
                    if !validate_scoped && remote.contains(&url) {
                        continue;
                    }
                    if remote.len() >= MAX_REMOTE_CONTEXTS {
                        return fail("context overflow", url);
                    }
                    let loaded = self.remote_context(&url)?;
                    let mut chain = remote.to_vec();
                    chain.push(url.clone());
                    let current = Rc::new(result);
                    result = self.process_context(
                        &current,
                        &loaded,
                        Some(&url),
                        &chain,
                        false,
                        true,
                        validate_scoped,
                    )?;
                    continue;
                }
                Value::Object(_) => {}
                other => return fail_value("invalid local context", other),
            }
            let Value::Object(mut map) = context else {
                continue;
            };
            if let Some(version) = map.get("@version")
                && *version != Value::Number(1.1)
            {
                return fail_value("invalid @version value", version);
            }
            if let Some(value) = map.get("@import").cloned() {
                let Value::String(reference) = &value else {
                    return fail_value("invalid @import value", &value);
                };
                let imported = self.remote_context(&resolve_iri(reference, base_url))?;
                let Value::Object(imported) = imported else {
                    return fail("invalid remote context", reference.to_string());
                };
                if imported.contains_key("@import") {
                    return fail("invalid context entry", format!("{reference} has @import"));
                }
                // `{ ...imported, ...map }`
                let mut merged = imported;
                for (key, value) in map.iter() {
                    merged.insert(key.clone(), value.clone());
                }
                map = merged;
            }
            if remote.is_empty()
                && let Some(value) = map.get("@base")
            {
                match value {
                    Value::Null => result.base = None,
                    Value::String(value) => {
                        // Lenient where the spec errs: a relative @base without a base stays relative.
                        result.base = Some(if is_absolute_iri(value) || result.base.is_none() {
                            value.to_string()
                        } else {
                            resolve_iri(value, result.base.as_deref())
                        });
                    }
                    other => return fail_value("invalid base IRI", other),
                }
            }
            if let Some(value) = map.get("@vocab") {
                match value {
                    Value::Null => result.vocab = None,
                    Value::String(text) => {
                        let vocab = self.expand_iri(&result, text, true, true);
                        match vocab {
                            Some(vocab) if !is_keyword(&vocab) => result.vocab = Some(vocab),
                            _ => return fail("invalid vocab mapping", text.to_string()),
                        }
                    }
                    other => return fail_value("invalid vocab mapping", other),
                }
            }
            if let Some(value) = map.get("@language") {
                match value {
                    Value::Null => result.language = None,
                    Value::String(text) => result.language = Some(to_lowercase(text).into_owned()),
                    other => return fail_value("invalid default language", other),
                }
            }
            if let Some(value) = map.get("@direction") {
                match value.as_str() {
                    _ if value.is_null() => result.direction = None,
                    Some("ltr") => result.direction = Some(Direction::Ltr),
                    Some("rtl") => result.direction = Some(Direction::Rtl),
                    _ => return fail_value("invalid base direction", value),
                }
            }
            if let Some(value) = map.get("@protected")
                && !matches!(value, Value::Bool(_))
            {
                return fail_value("invalid @protected value", value);
            }
            let terms: Vec<String> = map.keys().map(|k| k.to_string()).collect();
            let mut definitions = Definitions {
                local: map,
                defined: IndexMap::default(),
                base_url: base_url.map(str::to_owned),
                override_protected,
                remote: remote.to_vec(),
            };
            for term in terms {
                if !CONTEXT_KEYWORDS.contains(&term.as_str()) {
                    self.create_term_definition(&mut result, &term, &mut definitions)?;
                }
            }
        }
        Ok(result)
    }

    /// Context processing for property-, type- and map-scoped contexts.
    fn scoped_context(
        &mut self,
        active: &Rc<Context>,
        local: &Value,
        base_url: Option<&str>,
        override_protected: bool,
        propagate: bool,
    ) -> Ld<Rc<Context>> {
        self.process_context(
            active,
            local,
            base_url,
            &[],
            override_protected,
            propagate,
            true,
        )
        .map(Rc::new)
    }

    /// The `@context` of a remote document, from the caller's loader (never the network).
    fn remote_context(&mut self, url: &str) -> Ld<Value> {
        if let Some(cached) = self.loaded.get(url) {
            return Ok(cached.clone());
        }
        let Some(loader) = self.loader else {
            return fail(
                "loading remote context failed",
                format!(
                    "\"{url}\" was not loaded, as kgdiff never fetches documents; inline the context, or pass ParseOptions.jsonld.documentLoader"
                ),
            );
        };
        let document = match loader(url) {
            Err(message) => {
                return fail(
                    "loading remote context failed",
                    format!("\"{url}\": {message}"),
                );
            }
            Ok(None) => {
                return fail(
                    "loading remote context failed",
                    format!("documentLoader has no document for \"{url}\""),
                );
            }
            Ok(Some(LoadedDocument::Value(value))) => value,
            Ok(Some(LoadedDocument::Text(text))) => match parse_deep_json(&text) {
                Ok(value) => value,
                Err(JsonTextError::LoneSurrogate { reason, .. }) => {
                    // RFC 0002, D-2: as for the document itself.
                    return fail(
                        "loading remote context failed",
                        format!("\"{url}\": {reason}"),
                    );
                }
                Err(_) => {
                    return fail(
                        "loading remote context failed",
                        format!("\"{url}\" is not JSON"),
                    );
                }
            },
        };
        if document.is_null() {
            return fail(
                "loading remote context failed",
                format!("documentLoader has no document for \"{url}\""),
            );
        }
        if !has(&document, "@context") {
            return fail("invalid remote context", url);
        }
        let context = get(&document, "@context").cloned().unwrap_or(Value::Null);
        self.loaded.insert(url.to_owned(), context.clone());
        Ok(context)
    }

    // ─── Term definitions (§4.2) ────────────────────────────────────────────

    fn create_term_definition(
        &mut self,
        active: &mut Context,
        term: &str,
        scope: &mut Definitions,
    ) -> Ld<()> {
        match scope.defined.get(term) {
            Some(true) => return Ok(()),
            Some(false) => return fail("cyclic IRI mapping", term),
            None => {}
        }
        if term.is_empty() {
            return fail("invalid term definition", "an empty term");
        }
        scope.defined.insert(term.to_owned(), false);
        let raw = scope.local.get(term).cloned().unwrap_or(Value::Null);
        if term == "@type" && is_map(&raw) {
            let keys: Vec<&JsStr> = raw
                .as_object()
                .map(|o| o.keys().collect())
                .unwrap_or_default();
            let valid = !keys.is_empty()
                && keys
                    .iter()
                    .all(|k| matches!(k.as_str(), "@container" | "@protected"));
            if !valid || get(&raw, "@container").is_some_and(|c| c.as_str() != Some("@set")) {
                return fail("keyword redefinition", term);
            }
        } else if is_keyword(term) {
            return fail("keyword redefinition", term);
        } else if keyword_form(term) {
            scope.defined.insert(term.to_owned(), true);
            return Ok(());
        }
        let previous = active.terms.shift_remove(term);
        let mut simple_term = false;
        let value: Object = match &raw {
            Value::Null => {
                let mut o = Object::new();
                o.insert("@id", Value::Null);
                o
            }
            Value::String(s) => {
                simple_term = true;
                let mut o = Object::new();
                o.insert("@id", s.clone());
                o
            }
            Value::Object(o) => o.clone(),
            _ => return fail("invalid term definition", term),
        };
        let has_key = |key: &str| value.contains_key(key);
        let mut definition = TermDefinition {
            iri: None,
            prefix: false,
            protected: scope.local.get("@protected") == Some(&Value::Bool(true)),
            reverse: false,
            type_: None,
            language: None,
            direction: None,
            container: Vec::new(),
            index: None,
            nest: None,
            context: None,
            base_url: None,
        };
        if let Some(flag) = value.get("@protected") {
            let Value::Bool(flag) = flag else {
                return fail("invalid @protected value", term);
            };
            definition.protected = *flag;
        }
        if let Some(type_value) = value.get("@type") {
            let Value::String(type_value) = type_value else {
                return fail("invalid type mapping", term);
            };
            let expanded = self.expand_iri_defining(active, type_value, true, false, scope)?;
            let keyword_type = matches!(
                expanded.as_deref(),
                Some("@id" | "@json" | "@none" | "@vocab")
            );
            match expanded {
                Some(expanded)
                    if keyword_type || (!is_keyword(&expanded) && is_absolute_iri(&expanded)) =>
                {
                    definition.type_ = Some(expanded);
                }
                _ => return fail("invalid type mapping", term),
            }
        }
        if let Some(reverse) = value.get("@reverse") {
            if has_key("@id") || has_key("@nest") {
                return fail("invalid reverse property", term);
            }
            let Value::String(reverse) = reverse else {
                return fail("invalid IRI mapping", term);
            };
            if keyword_form(reverse) && !is_keyword(reverse) {
                scope.defined.insert(term.to_owned(), true);
                return Ok(());
            }
            let iri = self.expand_iri_defining(active, reverse, true, false, scope)?;
            match iri {
                Some(iri) if iri.contains(':') => definition.iri = Some(iri),
                _ => return fail("invalid IRI mapping", term),
            }
            if let Some(container) = value.get("@container") {
                match container.as_str() {
                    _ if container.is_null() => definition.container = Vec::new(),
                    Some(c @ ("@set" | "@index")) => definition.container = vec![c.to_owned()],
                    _ => return fail("invalid reverse property", term),
                }
            }
            definition.reverse = true;
            active.terms.insert(term.to_owned(), Rc::new(definition));
            scope.defined.insert(term.to_owned(), true);
            return Ok(());
        }
        let id_value = value.get("@id");
        if let Some(id) = id_value
            && id.as_str() != Some(term)
        {
            if let Value::String(id) = id {
                if keyword_form(id) && !is_keyword(id) {
                    scope.defined.insert(term.to_owned(), true);
                    return Ok(());
                }
                let iri = self.expand_iri_defining(active, id, true, false, scope)?;
                let iri = match iri {
                    Some(iri) if is_keyword(&iri) || iri.contains(':') => iri,
                    _ => return fail("invalid IRI mapping", term),
                };
                if iri == "@context" {
                    return fail("invalid keyword alias", term);
                }
                definition.iri = Some(iri.clone());
                let colon = colon_after_first(term);
                if colon.is_some_and(|c| c < term.len() - 1) || term.contains('/') {
                    scope.defined.insert(term.to_owned(), true);
                    let expanded = self.expand_iri_defining(active, term, true, false, scope)?;
                    if expanded.as_deref() != Some(iri.as_str()) {
                        return fail(
                            "invalid IRI mapping",
                            format!("{term} does not expand to its @id"),
                        );
                    }
                }
                if !term.contains(':')
                    && !term.contains('/')
                    && simple_term
                    && (gen_delim_end(&iri) || iri.starts_with("_:"))
                {
                    definition.prefix = true;
                }
            } else if !id.is_null() {
                return fail("invalid IRI mapping", term);
            }
        } else if let Some(colon) = colon_after_first(term) {
            let prefix = &term[..colon];
            if scope.local.contains_key(prefix) {
                self.create_term_definition(active, prefix, scope)?;
            }
            let prefix_iri = active.terms.get(prefix).and_then(|d| d.iri.clone());
            definition.iri = Some(match prefix_iri {
                Some(prefix_iri) => format!("{prefix_iri}{}", &term[colon + 1..]),
                None => term.to_owned(),
            });
        } else if term.contains('/') {
            match self.expand_iri(active, term, true, false) {
                Some(iri) if is_absolute_iri(&iri) => definition.iri = Some(iri),
                _ => return fail("invalid IRI mapping", term),
            }
        } else if term == "@type" {
            definition.iri = Some("@type".to_owned());
        } else if let Some(vocab) = &active.vocab {
            definition.iri = Some(format!("{vocab}{term}"));
        } else {
            return fail(
                "invalid IRI mapping",
                format!("{term} (no @id and no @vocab)"),
            );
        }
        if let Some(raw) = value.get("@container") {
            let container = arrayify(raw);
            let strings: Option<Vec<String>> = container
                .iter()
                .map(|c| c.as_str().map(str::to_owned))
                .collect();
            let Some(strings) = strings.filter(|s| valid_container(s)) else {
                return fail("invalid container mapping", term);
            };
            let mut sorted = strings.clone();
            sorted.sort_by(|a, b| compare_strings(a, b));
            definition.container = sorted;
            if strings.iter().any(|c| c == "@type") {
                match definition.type_.as_deref() {
                    None => definition.type_ = Some("@id".to_owned()),
                    Some("@id" | "@vocab") => {}
                    Some(_) => return fail("invalid type mapping", term),
                }
            }
        }
        if let Some(index) = value.get("@index") {
            let Value::String(index) = index.clone() else {
                return fail("invalid term definition", term);
            };
            if !definition.has_container("@index") {
                return fail("invalid term definition", term);
            }
            match self.expand_iri(active, &index, true, false) {
                Some(expanded) if !is_keyword(&expanded) && is_absolute_iri(&expanded) => {}
                _ => return fail("invalid term definition", term),
            }
            definition.index = Some(index.to_string());
        }
        if value.contains_key("@context") {
            let context = value.get("@context").cloned().unwrap_or(Value::Null);
            let current = Rc::new(active.clone());
            match self.process_context(
                &current,
                &context,
                scope.base_url.as_deref(),
                &scope.remote.clone(),
                true,
                true,
                false,
            ) {
                Ok(_) => {}
                Err(LdError::Ld { .. }) => return fail("invalid scoped context", term),
                Err(other) => return Err(other),
            }
            definition.context = Some(Rc::new(context));
            definition.base_url.clone_from(&scope.base_url);
        }
        if let Some(language) = value.get("@language")
            && !has_key("@type")
        {
            definition.language = Some(match language {
                Value::Null => None,
                Value::String(s) => Some(to_lowercase(s).into_owned()),
                _ => return fail("invalid language mapping", term),
            });
        }
        if let Some(direction) = value.get("@direction")
            && !has_key("@type")
        {
            definition.direction = Some(match direction.as_str() {
                _ if direction.is_null() => None,
                Some("ltr") => Some(Direction::Ltr),
                Some("rtl") => Some(Direction::Rtl),
                _ => return fail("invalid base direction", term),
            });
        }
        if let Some(nest) = value.get("@nest") {
            match nest.as_str() {
                Some(nest) if !is_keyword(nest) || nest == "@nest" => {
                    definition.nest = Some(nest.to_owned());
                }
                _ => return fail("invalid @nest value", term),
            }
        }
        if let Some(prefix) = value.get("@prefix") {
            if term.contains(':') || term.contains('/') {
                return fail("invalid term definition", term);
            }
            let Value::Bool(prefix) = prefix else {
                return fail("invalid @prefix value", term);
            };
            if *prefix && definition.iri.as_deref().is_some_and(is_keyword) {
                return fail("invalid term definition", term);
            }
            definition.prefix = *prefix;
        }
        for key in value.keys() {
            if !TERM_DEFINITION_KEYS.contains(&key.as_str()) {
                return fail("invalid term definition", format!("{term}: {key}"));
            }
        }
        match previous {
            Some(previous) if !scope.override_protected && previous.protected => {
                if !previous.same(&definition) {
                    return fail("protected term redefinition", term);
                }
                active.terms.insert(term.to_owned(), previous);
            }
            _ => {
                active.terms.insert(term.to_owned(), Rc::new(definition));
            }
        }
        scope.defined.insert(term.to_owned(), true);
        Ok(())
    }

    // ─── IRI expansion (§5.2) ───────────────────────────────────────────────

    /// IRI expansion without term definitions being created.
    fn expand_iri(
        &self,
        active: &Context,
        value: &str,
        vocab: bool,
        document_relative: bool,
    ) -> Option<String> {
        if is_keyword(value) {
            return Some(value.to_owned());
        }
        if keyword_form(value) {
            return None;
        }
        let definition = active.terms.get(value);
        if let Some(iri) = definition.and_then(|d| d.iri.as_ref())
            && is_keyword(iri)
        {
            return Some(iri.clone());
        }
        if vocab && let Some(definition) = definition {
            return definition.iri.clone();
        }
        if let Some(colon) = colon_after_first(value) {
            let (prefix, suffix) = (&value[..colon], &value[colon + 1..]);
            if prefix == "_" || suffix.starts_with("//") {
                return Some(value.to_owned());
            }
            if let Some(prefix_definition) = active.terms.get(prefix)
                && let Some(iri) = &prefix_definition.iri
                && prefix_definition.prefix
            {
                return Some(format!("{iri}{suffix}"));
            }
            if is_absolute_iri(value) {
                return Some(value.to_owned());
            }
        }
        if vocab && let Some(v) = &active.vocab {
            return Some(format!("{v}{value}"));
        }
        if document_relative {
            return Some(resolve_iri(value, active.base.as_deref()));
        }
        Some(value.to_owned())
    }

    /// IRI expansion while a local context is processed: terms it uses are defined first.
    fn expand_iri_defining(
        &mut self,
        active: &mut Context,
        value: &str,
        vocab: bool,
        document_relative: bool,
        scope: &mut Definitions,
    ) -> Ld<Option<String>> {
        if is_keyword(value) {
            return Ok(Some(value.to_owned()));
        }
        if keyword_form(value) {
            return Ok(None);
        }
        if scope.local.contains_key(value) && scope.defined.get(value) != Some(&true) {
            self.create_term_definition(active, value, scope)?;
        }
        let definition = active.terms.get(value);
        if let Some(iri) = definition.and_then(|d| d.iri.as_ref())
            && is_keyword(iri)
        {
            return Ok(Some(iri.clone()));
        }
        if vocab && let Some(definition) = definition {
            return Ok(definition.iri.clone());
        }
        if let Some(colon) = colon_after_first(value) {
            let prefix = &value[..colon];
            let suffix = &value[colon + 1..];
            if prefix == "_" || suffix.starts_with("//") {
                return Ok(Some(value.to_owned()));
            }
            if scope.local.contains_key(prefix) && scope.defined.get(prefix) != Some(&true) {
                self.create_term_definition(active, prefix, scope)?;
            }
            if let Some(prefix_definition) = active.terms.get(prefix)
                && let Some(iri) = &prefix_definition.iri
                && prefix_definition.prefix
            {
                return Ok(Some(format!("{iri}{suffix}")));
            }
            if is_absolute_iri(value) {
                return Ok(Some(value.to_owned()));
            }
        }
        if vocab && let Some(v) = &active.vocab {
            return Ok(Some(format!("{v}{value}")));
        }
        if document_relative {
            return Ok(Some(resolve_iri(value, active.base.as_deref())));
        }
        Ok(Some(value.to_owned()))
    }

    // ─── Expansion (§5.1) ───────────────────────────────────────────────────

    fn expand(
        &mut self,
        active: &Rc<Context>,
        active_property: Option<&str>,
        element: &Value,
        base_url: Option<&str>,
        from_map: bool,
        depth: usize,
    ) -> Ld<Value> {
        if depth > MAX_JSON_LD_NESTING {
            let mut details = Object::new();
            details.insert("format", "jsonld");
            return Err(LdError::Kgdiff(invalid_input_with(
                format!(
                    "JSON-LD nested deeper than {MAX_JSON_LD_NESTING} levels is not supported."
                ),
                details,
            )));
        }
        if element.is_null() {
            return Ok(Value::Null);
        }
        let definition = active_property.and_then(|p| active.terms.get(p)).cloned();
        if is_scalar(element) {
            let Some(property) = active_property.filter(|p| *p != "@graph") else {
                return Ok(Value::Null);
            };
            let context = match definition.as_ref().and_then(|d| d.context.clone()) {
                Some(local) => {
                    let base = definition.as_ref().and_then(|d| d.base_url.clone());
                    self.scoped_context(active, &local, base.as_deref(), false, true)?
                }
                None => Rc::clone(active),
            };
            return Ok(self.expand_value(&context, property, element));
        }
        if let Value::Array(items) = element {
            let mut result = Vec::new();
            let list = definition
                .as_ref()
                .is_some_and(|d| d.has_container("@list"));
            for item in items {
                let mut expanded =
                    self.expand(active, active_property, item, base_url, from_map, depth + 1)?;
                if list && matches!(expanded, Value::Array(_)) {
                    let mut o = Object::new();
                    o.insert("@list", expanded);
                    expanded = Value::Object(o);
                }
                match expanded {
                    Value::Array(values) => result.extend(values),
                    Value::Null => {}
                    other => result.push(other),
                }
            }
            return Ok(Value::Array(result));
        }
        self.expand_object(
            active,
            active_property,
            definition.as_deref(),
            element,
            base_url,
            from_map,
            depth,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn expand_object(
        &mut self,
        active: &Rc<Context>,
        active_property: Option<&str>,
        definition: Option<&TermDefinition>,
        element: &Value,
        base_url: Option<&str>,
        from_map: bool,
        depth: usize,
    ) -> Ld<Value> {
        let Value::Object(map) = element else {
            return Ok(Value::Null);
        };
        let mut context = Rc::clone(active);
        let keys: Vec<String> = map.keys().map(|k| k.to_string()).collect();
        if let Some(previous) = context.previous.clone()
            && !from_map
        {
            let keeps = keys.iter().any(|key| {
                let expanded = self.expand_iri(&context, key, true, false);
                expanded.as_deref() == Some("@value")
                    || (expanded.as_deref() == Some("@id") && keys.len() == 1)
            });
            if !keeps {
                context = previous;
            }
        }
        if let Some(local) = definition.and_then(|d| d.context.clone()) {
            let base = definition.and_then(|d| d.base_url.clone());
            context = self.scoped_context(&context, &local, base.as_deref(), true, true)?;
        }
        if map.contains_key("@context") {
            let local = map.get("@context").cloned().unwrap_or(Value::Null);
            context = Rc::new(self.process_context(
                &context,
                &local,
                base_url,
                &[],
                false,
                true,
                true,
            )?);
            if active_property.is_none() {
                self.collect_prefixes(&context);
            }
        }
        let type_scoped = Rc::clone(&context);
        let mut input_type: Option<String> = None;
        let mut sorted_keys = keys.clone();
        sorted_keys.sort_by(|a, b| compare_strings(a, b));
        for key in &sorted_keys {
            if self.expand_iri(&context, key, true, false).as_deref() != Some("@type") {
                continue;
            }
            let value = map.get(key).cloned().unwrap_or(Value::Null);
            let mut types: Vec<String> = arrayify(&value)
                .iter()
                .filter_map(|t| t.as_str().map(str::to_owned))
                .collect();
            types.sort_by(|a, b| compare_strings(a, b));
            for type_name in &types {
                if let Some(type_definition) = type_scoped.terms.get(type_name)
                    && let Some(local) = type_definition.context.clone()
                {
                    let base = type_definition.base_url.clone();
                    context =
                        self.scoped_context(&context, &local, base.as_deref(), false, false)?;
                }
            }
            if input_type.is_none()
                && let Some(Value::String(last)) = arrayify(&value).last()
            {
                input_type = self.expand_iri(&context, last, true, false);
            }
        }
        let mut result = Object::new();
        self.expand_entries(
            &context,
            &type_scoped,
            active_property,
            map,
            base_url,
            &mut result,
            input_type.as_deref(),
            depth,
        )?;

        let mut output = Value::Object(result);
        if let Value::Object(result) = &mut output {
            if result.contains_key("@value") {
                let result_keys: Vec<Value> =
                    result.keys().map(|k| Value::String(k.clone())).collect();
                if result.keys().any(|k| !VALUE_KEYS.contains(&k.as_str()))
                    || (result.contains_key("@type")
                        && (result.contains_key("@language") || result.contains_key("@direction")))
                {
                    return fail_value("invalid value object", &Value::Array(result_keys));
                }
                let type_value = result.get("@type").cloned();
                let value = result.get("@value").cloned().unwrap_or(Value::Null);
                if type_value.as_ref().and_then(Value::as_str) == Some("@json") {
                    // Any JSON value.
                } else if value.is_null() {
                    return Ok(Value::Null);
                } else if !matches!(value, Value::String(_)) && result.contains_key("@language") {
                    return fail_value("invalid language-tagged value", &value);
                } else if let Some(type_value) = &type_value {
                    match type_value.as_str() {
                        Some(t) if is_absolute_iri(t) && well_formed_iri(t) => {}
                        _ => return fail_value("invalid typed value", type_value),
                    }
                }
            } else if let Some(type_value) = result
                .get_mut("@type")
                .filter(|t| !matches!(t, Value::Array(_)))
            {
                let single = std::mem::take(type_value);
                *type_value = Value::Array(vec![single]);
            } else if result.contains_key("@set") || result.contains_key("@list") {
                let count = result.len();
                if count > 2 || (count == 2 && !result.contains_key("@index")) {
                    let result_keys: Vec<Value> =
                        result.keys().map(|k| Value::String(k.clone())).collect();
                    return fail_value("invalid set or list object", &Value::Array(result_keys));
                }
                if result.contains_key("@set") {
                    let set = result.get("@set").cloned().unwrap_or(Value::Null);
                    output = set;
                }
            }
        }
        if let Value::Object(o) = &output
            && o.len() == 1
            && o.contains_key("@language")
        {
            return Ok(Value::Null);
        }
        if active_property.is_none_or(|p| p == "@graph")
            && let Value::Object(o) = &output
        {
            if o.is_empty() || o.contains_key("@value") || o.contains_key("@list") {
                return Ok(Value::Null);
            }
            if o.len() == 1 && o.contains_key("@id") {
                return Ok(Value::Null);
            }
        }
        Ok(output)
    }

    /// Step 13 (and 14, nested properties) of the expansion algorithm.
    #[allow(clippy::too_many_arguments)]
    fn expand_entries(
        &mut self,
        context: &Rc<Context>,
        type_scoped: &Rc<Context>,
        active_property: Option<&str>,
        element: &Object,
        base_url: Option<&str>,
        result: &mut Object,
        input_type: Option<&str>,
        depth: usize,
    ) -> Ld<()> {
        let mut nests: Vec<String> = Vec::new();
        let mut keys: Vec<&JsStr> = element.keys().collect();
        keys.sort();
        for key in keys {
            let key: &str = key;
            if key == "@context" {
                continue;
            }
            let value = element.get(key).cloned().unwrap_or(Value::Null);
            let property = self.expand_iri(context, key, true, false);
            let Some(property) = property.filter(|p| p.contains(':') || is_keyword(p)) else {
                self.unmapped.insert(key.to_owned());
                continue;
            };
            if is_keyword(&property) {
                if active_property == Some("@reverse") {
                    return fail("invalid reverse property map", key);
                }
                if result.contains_key(&property) && property != "@included" && property != "@type"
                {
                    return fail("colliding keywords", property);
                }
                let expanded = match property.as_str() {
                    "@id" => {
                        let Value::String(id) = &value else {
                            return fail_value("invalid @id value", &value);
                        };
                        Value::from(self.expand_iri(context, id, false, true))
                    }
                    "@type" => {
                        let types = arrayify(&value);
                        if !types.iter().all(|t| matches!(t, Value::String(_))) {
                            return fail_value("invalid type value", &value);
                        }
                        let mut iris: Vec<Value> = Vec::new();
                        for t in &types {
                            if let Some(iri) =
                                self.expand_iri(type_scoped, t.as_str().unwrap_or(""), true, true)
                            {
                                iris.push(Value::from(iri));
                            }
                        }
                        let had = result.contains_key("@type");
                        let mut expanded = if had {
                            let mut all = arrayify(result.get("@type").unwrap_or(&Value::Null));
                            all.extend(iris.iter().cloned());
                            Value::Array(all)
                        } else {
                            Value::Array(iris.clone())
                        };
                        if !matches!(value, Value::Array(_)) && !had && iris.len() == 1 {
                            expanded = iris[0].clone();
                        }
                        expanded
                    }
                    "@graph" => Value::Array(arrayify(&self.expand(
                        context,
                        Some("@graph"),
                        &value,
                        base_url,
                        false,
                        depth + 1,
                    )?)),
                    "@included" => {
                        let included = arrayify(&self.expand(
                            context,
                            None,
                            &value,
                            base_url,
                            false,
                            depth + 1,
                        )?);
                        if !included.iter().all(is_node_object) {
                            return fail_value("invalid @included value", &value);
                        }
                        if result.contains_key("@included") {
                            let mut all = arrayify(result.get("@included").unwrap_or(&Value::Null));
                            all.extend(included);
                            Value::Array(all)
                        } else {
                            Value::Array(included)
                        }
                    }
                    "@value" => {
                        if input_type != Some("@json") && !value.is_null() && !is_scalar(&value) {
                            return fail_value("invalid value object value", &value);
                        }
                        value.clone()
                    }
                    "@language" => {
                        let Value::String(language) = &value else {
                            return fail_value("invalid language-tagged string", &value);
                        };
                        Value::from(to_lowercase(language).into_owned())
                    }
                    "@direction" => {
                        if !matches!(value.as_str(), Some("ltr" | "rtl")) {
                            return fail_value("invalid base direction", &value);
                        }
                        value.clone()
                    }
                    "@index" => {
                        if !matches!(value, Value::String(_)) {
                            return fail_value("invalid @index value", &value);
                        }
                        value.clone()
                    }
                    "@list" => {
                        let Some(property) = active_property.filter(|p| *p != "@graph") else {
                            continue;
                        };
                        Value::Array(arrayify(&self.expand(
                            context,
                            Some(property),
                            &value,
                            base_url,
                            false,
                            depth + 1,
                        )?))
                    }
                    "@set" => {
                        self.expand(context, active_property, &value, base_url, false, depth + 1)?
                    }
                    "@reverse" => {
                        self.expand_reverse(context, &value, base_url, result, depth)?;
                        continue;
                    }
                    "@nest" => {
                        nests.push(key.to_owned());
                        continue;
                    }
                    _ => continue,
                };
                // A null @value is kept: whether @type means a datatype depends on it.
                result.insert(property.as_str(), expanded);
                continue;
            }

            let definition = context.terms.get(key).cloned();
            let container: Vec<String> = definition
                .as_ref()
                .map(|d| d.container.clone())
                .unwrap_or_default();
            let has_container = |name: &str| container.iter().any(|c| c == name);
            let mut expanded =
                if definition.as_ref().and_then(|d| d.type_.as_deref()) == Some("@json") {
                    let mut o = Object::new();
                    o.insert("@value", value.clone());
                    o.insert("@type", "@json");
                    Value::Object(o)
                } else if has_container("@language")
                    && let Value::Object(map) = &value
                {
                    Value::Array(self.expand_language_map(context, definition.as_deref(), map)?)
                } else if let (Some(def), Value::Object(map)) = (definition.as_ref(), &value)
                    && (has_container("@index") || has_container("@type") || has_container("@id"))
                {
                    Value::Array(self.expand_index_map(context, key, def, map, base_url, depth)?)
                } else {
                    self.expand(context, Some(key), &value, base_url, false, depth + 1)?
                };
            if expanded.is_null() {
                continue;
            }
            if has_container("@list") && !is_list_object(&expanded) {
                let mut o = Object::new();
                o.insert("@list", Value::Array(arrayify(&expanded)));
                expanded = Value::Object(o);
            }
            if has_container("@graph") && !has_container("@id") && !has_container("@index") {
                expanded = Value::Array(
                    arrayify(&expanded)
                        .into_iter()
                        .map(|item| {
                            let mut o = Object::new();
                            o.insert("@graph", Value::Array(arrayify(&item)));
                            Value::Object(o)
                        })
                        .collect(),
                );
            }
            if definition.as_ref().is_some_and(|d| d.reverse) {
                let reverse_map = reverse_map_of(result);
                for item in arrayify(&expanded) {
                    if is_value_object(&item) || is_list_object(&item) {
                        return fail("invalid reverse property value", key);
                    }
                    add_values(reverse_map, &property, vec![item]);
                }
            } else {
                add_values(result, &property, arrayify(&expanded));
            }
        }
        // Nested properties belong to the node, read with the nesting term's scoped context.
        nests.sort_by(|a, b| compare_strings(a, b));
        for nest in &nests {
            let nest_definition = context.terms.get(nest).cloned();
            let nest_context = match nest_definition.as_ref().and_then(|d| d.context.clone()) {
                Some(local) => {
                    let base = nest_definition.as_ref().and_then(|d| d.base_url.clone());
                    self.scoped_context(context, &local, base.as_deref(), true, true)?
                }
                None => Rc::clone(context),
            };
            for nested in arrayify(element.get(nest).unwrap_or(&Value::Null)) {
                let Value::Object(nested_map) = &nested else {
                    return fail_value("invalid @nest value", &nested);
                };
                if nested_map.keys().any(|k| {
                    self.expand_iri(&nest_context, k, true, false).as_deref() == Some("@value")
                }) {
                    return fail_value("invalid @nest value", &nested);
                }
                self.expand_entries(
                    &nest_context,
                    type_scoped,
                    Some(nest),
                    nested_map,
                    base_url,
                    result,
                    input_type,
                    depth + 1,
                )?;
            }
        }
        Ok(())
    }

    fn expand_reverse(
        &mut self,
        context: &Rc<Context>,
        value: &Value,
        base_url: Option<&str>,
        result: &mut Object,
        depth: usize,
    ) -> Ld<()> {
        if !is_map(value) {
            return fail_value("invalid @reverse value", value);
        }
        let expanded = self.expand(context, Some("@reverse"), value, base_url, false, depth + 1)?;
        let Value::Object(expanded) = expanded else {
            return Ok(());
        };
        if let Some(Value::Object(doubled)) = expanded.get("@reverse") {
            for (property, values) in doubled.iter() {
                add_values(result, property, arrayify(values));
            }
        }
        for (property, values) in expanded.iter() {
            if property.as_str() == "@reverse" {
                continue;
            }
            let reverse_map = reverse_map_of(result);
            for item in arrayify(values) {
                if is_value_object(&item) || is_list_object(&item) {
                    return fail("invalid reverse property value", property.to_string());
                }
                add_values(reverse_map, property, vec![item]);
            }
        }
        Ok(())
    }

    fn expand_language_map(
        &self,
        context: &Context,
        definition: Option<&TermDefinition>,
        value: &Object,
    ) -> Ld<Vec<Value>> {
        let mut out = Vec::new();
        let direction = match definition.and_then(|d| d.direction) {
            Some(direction) => direction,
            None => context.direction,
        };
        let mut languages: Vec<&JsStr> = value.keys().collect();
        languages.sort();
        for language in languages {
            let none = self.expand_iri(context, language, true, false).as_deref() == Some("@none");
            for item in arrayify(value.get(language).unwrap_or(&Value::Null)) {
                match &item {
                    Value::Null => continue,
                    Value::String(_) => {}
                    _ => return fail_value("invalid language map value", &item),
                }
                let mut expanded = Object::new();
                expanded.insert("@value", item);
                if !none {
                    expanded.insert("@language", to_lowercase(language).into_owned());
                }
                if let Some(direction) = direction {
                    expanded.insert("@direction", direction.as_str());
                }
                out.push(Value::Object(expanded));
            }
        }
        Ok(out)
    }

    /// Index, id and type maps (§5.1.2 step 13.8).
    fn expand_index_map(
        &mut self,
        context: &Rc<Context>,
        key: &str,
        definition: &TermDefinition,
        value: &Object,
        base_url: Option<&str>,
        depth: usize,
    ) -> Ld<Vec<Value>> {
        let mut out = Vec::new();
        let index_key = definition
            .index
            .clone()
            .unwrap_or_else(|| "@index".to_owned());
        let by_id_or_type = definition.has_container("@id") || definition.has_container("@type");
        let mut indices: Vec<&JsStr> = value.keys().collect();
        indices.sort();
        for index in indices {
            let index: &str = index;
            let mut map_context = if by_id_or_type {
                context
                    .previous
                    .clone()
                    .unwrap_or_else(|| Rc::clone(context))
            } else {
                Rc::clone(context)
            };
            if definition.has_container("@type")
                && let Some(index_definition) = map_context.terms.get(index).cloned()
                && let Some(local) = index_definition.context.clone()
            {
                let base = index_definition.base_url.clone();
                map_context =
                    self.scoped_context(&map_context, &local, base.as_deref(), false, true)?;
            }
            let expanded_index = self.expand_iri(context, index, true, false);
            let items = arrayify(&self.expand(
                &map_context,
                Some(key),
                &Value::Array(arrayify(value.get(index).unwrap_or(&Value::Null))),
                base_url,
                true,
                depth + 1,
            )?);
            let not_none = expanded_index.as_deref() != Some("@none");
            for mut item in items {
                if definition.has_container("@graph") && !is_graph_object(&item) {
                    let mut o = Object::new();
                    o.insert("@graph", Value::Array(arrayify(&item)));
                    item = Value::Object(o);
                }
                let Value::Object(object) = &mut item else {
                    continue;
                };
                if definition.has_container("@index") && index_key != "@index" && not_none {
                    if object.contains_key("@value") {
                        return fail_value("invalid value object", &Value::Object(object.clone()));
                    }
                    let re_expanded = self.expand_value(context, &index_key, &Value::from(index));
                    if let Some(index_property) = self.expand_iri(context, &index_key, true, false)
                    {
                        let mut values = vec![re_expanded];
                        values.extend(
                            object
                                .get(&index_property)
                                .map(arrayify)
                                .unwrap_or_default(),
                        );
                        object.insert(index_property.as_str(), Value::Array(values));
                    }
                } else if definition.has_container("@index")
                    && !object.contains_key("@index")
                    && not_none
                {
                    object.insert("@index", index);
                } else if definition.has_container("@id") && !object.contains_key("@id") && not_none
                {
                    object.insert(
                        "@id",
                        Value::from(self.expand_iri(context, index, false, true)),
                    );
                } else if definition.has_container("@type") && not_none {
                    let mut types = vec![Value::from(expanded_index.clone())];
                    types.extend(object.get("@type").map(arrayify).unwrap_or_default());
                    object.insert("@type", Value::Array(types));
                }
                out.push(item);
            }
        }
        Ok(out)
    }

    /// Value expansion (§5.3).
    fn expand_value(&self, context: &Context, active_property: &str, value: &Value) -> Value {
        let definition = context.terms.get(active_property);
        let type_name = definition.and_then(|d| d.type_.as_deref());
        if let Value::String(text) = value {
            if type_name == Some("@id") {
                let mut o = Object::new();
                o.insert(
                    "@id",
                    Value::from(self.expand_iri(context, text, false, true)),
                );
                return Value::Object(o);
            }
            if type_name == Some("@vocab") {
                let mut o = Object::new();
                o.insert(
                    "@id",
                    Value::from(self.expand_iri(context, text, true, true)),
                );
                return Value::Object(o);
            }
        }
        let mut result = Object::new();
        result.insert("@value", value.clone());
        match type_name {
            Some(t) if !matches!(t, "@id" | "@vocab" | "@none") => {
                result.insert("@type", t);
            }
            _ => {
                if matches!(value, Value::String(_)) {
                    let language = match definition.and_then(|d| d.language.clone()) {
                        Some(language) => language,
                        None => context.language.clone(),
                    };
                    let direction = match definition.and_then(|d| d.direction) {
                        Some(direction) => direction,
                        None => context.direction,
                    };
                    if let Some(language) = language {
                        result.insert("@language", language);
                    }
                    if let Some(direction) = direction {
                        result.insert("@direction", direction.as_str());
                    }
                }
            }
        }
        Value::Object(result)
    }

    /// Prefix-capable terms of a top-level context, reported for display like `@prefix`.
    fn collect_prefixes(&mut self, context: &Context) {
        for (term, definition) in &context.terms {
            let Some(iri) = &definition.iri else {
                continue;
            };
            if !definition.prefix || is_keyword(iri) || iri.starts_with("_:") {
                continue;
            }
            if !self.prefixes.contains_key(term) {
                self.prefixes.insert(term.clone(), iri.clone());
            }
        }
        if let Some(vocab) = &context.vocab
            && !self.prefixes.contains_key("")
        {
            self.prefixes.insert(String::new(), vocab.clone());
        }
    }

    // ─── Deserialization to RDF (§8) ────────────────────────────────────────

    /// Emits the triples of a node object (and of every node it embeds) and returns its
    /// subject, or `None` when its id is not a usable IRI.
    fn emit_node(&mut self, node: &Object, graph: &Term) -> Option<Term> {
        let subject = if node.contains_key("@id") {
            self.resource_term(Some(node.get("@id").unwrap_or(&Value::Null)))
        } else {
            self.resource_term(None)
        };
        let rdf_type = self.iri(&format!("{RDF_NS}type"));
        for type_value in node.get("@type").map(arrayify).unwrap_or_default() {
            let object = match &type_value {
                Value::String(_) => self.resource_term(Some(&type_value)),
                _ => None,
            };
            if let (Some(subject), Some(object)) = (&subject, object) {
                self.emit(subject.clone(), rdf_type.clone(), object, graph);
            }
        }
        for (property, values) in node.iter() {
            if is_keyword(property) {
                continue;
            }
            let predicate = self.predicate_term(property);
            for item in arrayify(values) {
                let object = self.object_term(&item, graph);
                if let (Some(subject), Some(predicate), Some(object)) =
                    (&subject, &predicate, object)
                {
                    self.emit(subject.clone(), predicate.clone(), object, graph);
                }
            }
        }
        if let Some(Value::Object(reverse)) = node.get("@reverse") {
            for (property, values) in reverse.iter() {
                let predicate = self.predicate_term(property);
                for item in arrayify(values) {
                    let object = match &item {
                        Value::Object(item) => self.emit_node(item, graph),
                        _ => None,
                    };
                    if let (Some(subject), Some(predicate), Some(object)) =
                        (&subject, &predicate, object)
                    {
                        self.emit(object, predicate.clone(), subject.clone(), graph);
                    }
                }
            }
        }
        // A graph whose name RDF cannot represent is dropped with its triples, as the spec says.
        if node.contains_key("@graph")
            && let Some(subject) = &subject
        {
            for child in arrayify(node.get("@graph").unwrap_or(&Value::Null)) {
                if let Value::Object(child) = child {
                    self.emit_node(&child, subject);
                }
            }
        }
        for child in node.get("@included").map(arrayify).unwrap_or_default() {
            if let Value::Object(child) = child {
                self.emit_node(&child, graph);
            }
        }
        subject
    }

    /// Object to RDF (§8.2): a resource, a literal, or a list head.
    fn object_term(&mut self, item: &Value, graph: &Term) -> Option<Term> {
        let Value::Object(map) = item else {
            return None;
        };
        if map.contains_key("@value") {
            return self.literal_term(map);
        }
        if map.contains_key("@list") {
            return Some(
                self.list_term(&arrayify(map.get("@list").unwrap_or(&Value::Null)), graph),
            );
        }
        self.emit_node(map, graph)
    }

    /// List to RDF (§8.3): cells are created even for items that produce no object.
    fn list_term(&mut self, items: &[Value], graph: &Term) -> Term {
        let nil = self.iri(&format!("{RDF_NS}nil"));
        if items.is_empty() {
            return nil;
        }
        let cells: Vec<Term> = items.iter().map(|_| self.blank()).collect();
        let (first, rest) = (
            self.iri(&format!("{RDF_NS}first")),
            self.iri(&format!("{RDF_NS}rest")),
        );
        for (i, item) in items.iter().enumerate() {
            let cell = cells[i].clone();
            if let Some(object) = self.object_term(item, graph) {
                self.emit(cell.clone(), first.clone(), object, graph);
            }
            let next = cells.get(i + 1).cloned().unwrap_or_else(|| nil.clone());
            self.emit(cell, rest.clone(), next, graph);
        }
        cells[0].clone()
    }

    fn literal_term(&mut self, item: &Object) -> Option<Term> {
        let value = item.get("@value").cloned().unwrap_or(Value::Null);
        let mut datatype = item.get("@type").and_then(Value::as_str).map(str::to_owned);
        let language = item
            .get("@language")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if let Some(d) = &datatype
            && d != "@json"
            && !well_formed_iri(d)
        {
            return None;
        }
        if let Some(l) = &language
            && !language_tag(l)
        {
            return None;
        }
        let lexical = if datatype.as_deref() == Some("@json") {
            datatype = Some(format!("{RDF_NS}JSON"));
            canonical_json(&value)
        } else {
            match &value {
                Value::Bool(b) => {
                    datatype.get_or_insert_with(|| format!("{XSD_NS}boolean"));
                    b.to_string()
                }
                Value::Number(x)
                    if !(x.is_finite() && x.trunc() == *x)
                        || x.abs() >= 1e21
                        || datatype.as_deref() == Some(&format!("{XSD_NS}double")) =>
                {
                    datatype.get_or_insert_with(|| format!("{XSD_NS}double"));
                    canonical_double(*x)
                }
                Value::Number(x) => {
                    datatype.get_or_insert_with(|| format!("{XSD_NS}integer"));
                    js::to_fixed(*x, 0)
                }
                Value::String(s) => s.to_string(),
                _ => return None,
            }
        };
        let lang_string = format!("{RDF_NS}langString");
        if let Some(language) = &language
            && datatype.as_deref().is_none_or(|d| d == lang_string)
        {
            return Some(Term::Literal(Literal::new(
                &lexical,
                LiteralKind::Language(language, None),
            )));
        }
        Some(Term::Literal(match datatype {
            None => Literal::string(&lexical),
            Some(d) => {
                let d = self.iri(&d);
                Literal::new(&lexical, LiteralKind::Datatype(d.value()))
            }
        }))
    }

    /// A node id or type: blank node id, IRI, or nothing when RDF cannot represent it.
    fn resource_term(&mut self, id: Option<&Value>) -> Option<Term> {
        let Some(id) = id else {
            return Some(self.blank());
        };
        let Value::String(id) = id else {
            return None;
        };
        if let Some(label) = id.strip_prefix("_:") {
            return Some(Term::blank(format!("j{label}")));
        }
        well_formed_iri(id).then(|| self.iri(id))
    }

    /// Blank node predicates would be generalized RDF, which is not produced.
    fn predicate_term(&mut self, property: &str) -> Option<Term> {
        (!property.starts_with("_:") && well_formed_iri(property)).then(|| self.iri(property))
    }

    fn blank(&mut self) -> Term {
        let term = Term::blank(format!("g{}", self.blanks));
        self.blanks += 1;
        term
    }

    fn iri(&mut self, value: &str) -> Term {
        if let Some(shared) = self.iris.get(value) {
            return Term::Named(shared.clone());
        }
        let shared: Rc<str> = value.into();
        self.iris.insert(value.to_owned(), shared.clone());
        Term::Named(shared)
    }

    fn emit(&mut self, subject: Term, predicate: Term, object: Term, graph: &Term) {
        self.quads.push(Quad {
            subject,
            predicate,
            object,
            graph: graph.clone(),
        });
    }
}

fn reverse_map_of(result: &mut Object) -> &mut Object {
    if !matches!(result.get("@reverse"), Some(Value::Object(_))) {
        result.insert("@reverse", Value::Object(Object::new()));
    }
    match result.get_mut("@reverse") {
        Some(Value::Object(map)) => map,
        _ => unreachable!("@reverse was just set to an object"),
    }
}

/// The canonical xsd:double: `1.1E0`, `1.0E-4`, `-5.0E21` (`canonicalDouble`).
fn canonical_double(value: f64) -> String {
    let text = js::to_exponential(value);
    let (mantissa, exponent) = match text.split_once('e') {
        Some((m, e)) => (m.to_owned(), e.to_owned()),
        None => (text.clone(), "0".to_owned()),
    };
    let mantissa = if mantissa.contains('.') {
        mantissa
    } else {
        format!("{mantissa}.0")
    };
    format!(
        "{mantissa}E{}",
        js::number_to_string(js::number_from_str(&exponent))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_doubles() {
        assert_eq!(canonical_double(1.5), "1.5E0");
        assert_eq!(canonical_double(1e21), "1.0E21");
        assert_eq!(canonical_double(0.0001), "1.0E-4");
        assert_eq!(canonical_double(f64::INFINITY), "Infinity.0E0");
    }
}
