//! IRI compaction (`prefixes.ts`): well-known prefixes, declared prefixes and the OBO PURL rule
//! (`http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`).

use std::cell::RefCell;

use kgdiff_core::js::{self, IndexMap, JsStr, Lookup, Object};

use crate::shared::compare_strings;

pub const RDF_NS: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#";
pub const RDFS_NS: &str = "http://www.w3.org/2000/01/rdf-schema#";
pub const OWL_NS: &str = "http://www.w3.org/2002/07/owl#";
pub const XSD_NS: &str = "http://www.w3.org/2001/XMLSchema#";
pub const SKOS_NS: &str = "http://www.w3.org/2004/02/skos/core#";
pub const OBO_IN_OWL_NS: &str = "http://www.geneontology.org/formats/oboInOwl#";
pub const OBO_PURL: &str = "http://purl.obolibrary.org/obo/";
pub const DC_NS: &str = "http://purl.org/dc/elements/1.1/";
pub const DCTERMS_NS: &str = "http://purl.org/dc/terms/";
pub const FOAF_NS: &str = "http://xmlns.com/foaf/0.1/";

/// Prefixes every parser knows without a declaration (`WELL_KNOWN_PREFIXES`), by name.
pub const WELL_KNOWN_PREFIXES: &[(&str, &str)] = &[
    ("dc", DC_NS),
    ("dcterms", DCTERMS_NS),
    ("foaf", FOAF_NS),
    ("obo", OBO_PURL),
    ("oboInOwl", OBO_IN_OWL_NS),
    ("owl", OWL_NS),
    ("prov", "http://www.w3.org/ns/prov#"),
    ("rdf", RDF_NS),
    ("rdfs", RDFS_NS),
    ("schema", "https://schema.org/"),
    ("skos", SKOS_NS),
    ("xsd", XSD_NS),
];

/// Namespaces that compact to a well-known prefix besides its canonical namespace.
const WELL_KNOWN_VARIANTS: &[(&str, &str)] = &[("schema", "http://schema.org/")];

/// The well-known prefixes as a list of pairs (a `Record` in TypeScript).
pub fn well_known() -> Vec<(String, String)> {
    WELL_KNOWN_PREFIXES
        .iter()
        .map(|(p, n)| ((*p).to_owned(), (*n).to_owned()))
        .collect()
}

fn well_known_namespace(prefix: &str) -> Option<&'static str> {
    WELL_KNOWN_PREFIXES
        .iter()
        .find(|(p, _)| *p == prefix)
        .map(|(_, n)| *n)
}

/// `/^([A-Za-z][A-Za-z0-9]*)_([^\s/#?]+)$/` on the local part of an OBO PURL.
fn obo_local_id(local: &str) -> Option<(&str, &str)> {
    let bytes = local.as_bytes();
    if !bytes.first()?.is_ascii_alphabetic() {
        return None;
    }
    let end = bytes
        .iter()
        .position(|b| !b.is_ascii_alphanumeric())
        .unwrap_or(bytes.len());
    if bytes.get(end) != Some(&b'_') {
        return None;
    }
    let rest = &local[end + 1..];
    if rest.is_empty()
        || rest
            .chars()
            .any(|c| js::is_whitespace(c) || "/#?".contains(c))
    {
        return None;
    }
    Some((&local[..end], rest))
}

/// `oboCurie`: `http://purl.obolibrary.org/obo/GO_0008150` → `GO:0008150`.
pub fn obo_curie(iri: &str) -> Option<String> {
    let local = iri.strip_prefix(OBO_PURL)?;
    let (space, id) = obo_local_id(local)?;
    Some(format!("{space}:{id}"))
}

/// `nodeIdForIri`: OBO PURLs become CURIEs, every other IRI stays whole.
pub fn node_id_for_iri(iri: &str) -> String {
    obo_curie(iri).unwrap_or_else(|| iri.to_owned())
}

/// Where a prefix came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PrefixSource {
    User,
    WellKnown,
    Declared,
}

impl PrefixSource {
    /// Preference when several names share one namespace (lower wins).
    fn preference(self) -> u8 {
        match self {
            PrefixSource::User => 0,
            PrefixSource::WellKnown => 1,
            PrefixSource::Declared => 2,
        }
    }

    /// Override order per name: well-known, then declared, then user.
    fn override_rank(self) -> u8 {
        match self {
            PrefixSource::WellKnown => 0,
            PrefixSource::Declared => 1,
            PrefixSource::User => 2,
        }
    }
}

#[derive(Clone, Debug)]
struct Entry {
    prefix: String,
    namespace: String,
    preference: u8,
}

/// A compiled prefix map (`PrefixTable`). Compaction picks the longest matching namespace; when
/// several prefixes share a namespace, explicit options beat well-known names, which beat file
/// declarations.
#[non_exhaustive]
pub struct PrefixTable {
    /// Name → namespace, sorted by name (`ParseResult.prefixes`).
    pub record: Vec<(String, String)>,
    entries: Vec<Entry>,
    namespaces: Lookup<String, String>,
    cache: RefCell<Lookup<String, String>>,
}

impl PrefixTable {
    pub fn new(layers: &[(PrefixSource, &[(String, String)])]) -> PrefixTable {
        let mut ordered: Vec<&(PrefixSource, &[(String, String)])> = layers.iter().collect();
        ordered.sort_by_key(|(source, _)| source.override_rank());
        let mut by_name: IndexMap<String, Entry> = IndexMap::default();
        for (source, prefixes) in ordered {
            for (prefix, namespace) in object_entries(prefixes) {
                if !namespace.is_empty() {
                    by_name.insert(
                        prefix.clone(),
                        Entry {
                            prefix: prefix.clone(),
                            namespace: namespace.clone(),
                            preference: source.preference(),
                        },
                    );
                }
            }
        }
        let mut names: Vec<&String> = by_name.keys().collect();
        names.sort_by(|a, b| compare_strings(a, b));
        let mut record = Vec::with_capacity(names.len());
        let mut namespaces = Lookup::new();
        for name in names {
            let entry = &by_name[name];
            record.push((name.clone(), entry.namespace.clone()));
            namespaces.insert(name.clone(), entry.namespace.clone());
        }
        let mut entries: Vec<Entry> = by_name.values().cloned().collect();
        for (prefix, namespace) in WELL_KNOWN_VARIANTS {
            if by_name.get(*prefix).map(|e| e.namespace.as_str()) == well_known_namespace(prefix) {
                entries.push(Entry {
                    prefix: (*prefix).to_owned(),
                    namespace: (*namespace).to_owned(),
                    preference: PrefixSource::WellKnown.preference(),
                });
            }
        }
        // Longest namespace first; for equal namespaces the preferred name first.
        entries.sort_by(|a, b| {
            js::utf16_len(&b.namespace)
                .cmp(&js::utf16_len(&a.namespace))
                .then_with(|| compare_strings(&a.namespace, &b.namespace))
                .then_with(|| a.preference.cmp(&b.preference))
                .then_with(|| js::utf16_len(&a.prefix).cmp(&js::utf16_len(&b.prefix)))
                .then_with(|| compare_strings(&a.prefix, &b.prefix))
        });
        PrefixTable {
            record,
            entries,
            namespaces,
            cache: RefCell::new(Lookup::new()),
        }
    }

    /// The table of `compactIri`: well-known prefixes overlaid with `prefixes` (`tableFor`).
    pub fn for_user(prefixes: Option<&[(String, String)]>) -> PrefixTable {
        let well_known = well_known();
        match prefixes {
            None => PrefixTable::new(&[(PrefixSource::WellKnown, &well_known)]),
            Some(user) => PrefixTable::new(&[
                (PrefixSource::WellKnown, &well_known),
                (PrefixSource::User, user),
            ]),
        }
    }

    /// The record as a JSON object (`ParseResult.prefixes`).
    pub fn record_object(&self) -> Object {
        self.record
            .iter()
            .map(|(k, v)| (JsStr::from(k.as_str()), v.as_str()))
            .collect()
    }

    /// The compact form of `iri` (cached), or `iri` itself when no prefix applies.
    pub fn compact(&self, iri: &str) -> String {
        if let Some(known) = self.cache.borrow().get(iri) {
            return known.clone();
        }
        let compact = self.compute(iri);
        self.cache
            .borrow_mut()
            .insert(iri.to_owned(), compact.clone());
        compact
    }

    /// `expand`: a CURIE with a known prefix (or an OBO-style `GO:0008150`) as a full IRI;
    /// strings that already look like absolute IRIs come back unchanged.
    pub fn expand(&self, value: &str) -> String {
        if looks_like_url(value) || value.starts_with("urn:") {
            return value.to_owned();
        }
        let Some(colon) = value.find(':') else {
            return value.to_owned();
        };
        let (prefix, local) = (&value[..colon], &value[colon + 1..]);
        if let Some(namespace) = self.namespaces.get(prefix) {
            return format!("{namespace}{local}");
        }
        // Undeclared upper-case id spaces (`IAO:0100001`) follow the OBO PURL convention.
        let b = prefix.as_bytes();
        if !b.is_empty() && b[0].is_ascii_uppercase() && b.iter().all(u8::is_ascii_alphanumeric) {
            return format!("{OBO_PURL}{prefix}_{local}");
        }
        value.to_owned()
    }

    fn compute(&self, iri: &str) -> String {
        if let Some(obo) = obo_curie(iri) {
            let space = &obo[..obo.find(':').unwrap_or(0)];
            match self.namespaces.get(space) {
                None => return obo,
                Some(declared) if *declared == format!("{OBO_PURL}{space}_") => return obo,
                Some(_) => {}
            }
        }
        for entry in &self.entries {
            if let Some(local) = iri.strip_prefix(entry.namespace.as_str()) {
                return format!("{}:{local}", entry.prefix);
            }
        }
        iri.to_owned()
    }
}

/// `/^[a-z][a-z0-9+.-]*:\/\//i`.
fn looks_like_url(value: &str) -> bool {
    let b = value.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    let end = b
        .iter()
        .position(|c| !(c.is_ascii_alphanumeric() || b"+.-".contains(c)))
        .unwrap_or(b.len());
    value[end..].starts_with("://")
}

/// `Object.entries` of a record built by assignment: canonical array-index keys first, in
/// numeric order, then the rest in insertion order; a repeated key keeps its first position and
/// its last value.
pub fn object_entries(pairs: &[(String, String)]) -> Vec<(String, String)> {
    let mut map: IndexMap<String, String> = IndexMap::default();
    for (k, v) in pairs {
        map.insert(k.clone(), v.clone());
    }
    let mut indices: Vec<(u32, String, String)> = Vec::new();
    let mut rest = Vec::new();
    for (k, v) in map {
        match js::array_index(&k) {
            Some(i) => indices.push((i, k, v)),
            None => rest.push((k, v)),
        }
    }
    indices.sort_by_key(|(i, _, _)| *i);
    indices
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(rest)
        .collect()
}

/// `readableName`: the local part after the last `#`, `/` or `:`, with `_` as spaces; opaque
/// local parts (digits only) keep the whole compact form (`BFO:0000050`).
pub fn readable_name(value: &str) -> String {
    let cut = value.rfind(['#', '/', ':']);
    let local = match cut {
        Some(i) => &value[i + 1..],
        None => value,
    };
    if local.is_empty() || local.bytes().all(|b| b.is_ascii_digit()) {
        return value.to_owned();
    }
    local.replace('_', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compacts_and_expands() {
        let table = PrefixTable::for_user(None);
        assert_eq!(
            table.compact("http://purl.obolibrary.org/obo/GO_0008150"),
            "GO:0008150"
        );
        assert_eq!(table.compact("http://schema.org/name"), "schema:name");
        assert_eq!(table.compact("https://schema.org/name"), "schema:name");
        assert_eq!(
            table.compact("http://example.org/x"),
            "http://example.org/x"
        );
        assert_eq!(
            table.expand("IAO:0100001"),
            "http://purl.obolibrary.org/obo/IAO_0100001"
        );
        assert_eq!(table.expand("rdfs:label"), format!("{RDFS_NS}label"));
        assert_eq!(table.expand("http://x"), "http://x");
        assert_eq!(
            obo_curie(&format!("{OBO_PURL}ab_cd_ef")).as_deref(),
            Some("ab:cd_ef")
        );
        assert_eq!(obo_curie(&format!("{OBO_PURL}GO-1_2")), None);
    }

    #[test]
    fn readable_names() {
        assert_eq!(readable_name("BFO:0000050"), "BFO:0000050");
        assert_eq!(readable_name("ex:part_of"), "part of");
        assert_eq!(readable_name("http://e/a#b_c"), "b c");
        assert_eq!(readable_name("plain"), "plain");
    }
}
