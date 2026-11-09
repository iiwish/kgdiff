//! IRI references for RDF/XML and JSON-LD (`iri.ts`): the absolute-IRI test and RFC 3986 §5.2
//! resolution. Absolute IRIs are kept as written, so one resource gets one id whichever syntax
//! names it. Pure string operations; nothing is ever fetched.

/// `/^[A-Za-z][A-Za-z0-9+.-]*:/`: whether `value` starts with a scheme (`_:` does not count).
pub fn is_absolute_iri(value: &str) -> bool {
    let b = value.as_bytes();
    if !b.first().is_some_and(u8::is_ascii_alphabetic) {
        return false;
    }
    let end = b
        .iter()
        .position(|c| !(c.is_ascii_alphanumeric() || b"+.-".contains(c)))
        .unwrap_or(b.len());
    b.get(end) == Some(&b':')
}

/// The groups of RFC 3986 appendix B's regular expression,
/// `^(?:([^:/?#]+):)?(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$`: `None` for a group
/// that did not take part in the match.
struct Parts<'a> {
    scheme: Option<&'a str>,
    authority: Option<&'a str>,
    path: &'a str,
    query: Option<&'a str>,
    fragment: Option<&'a str>,
}

fn parts(text: &str) -> Parts<'_> {
    let mut rest = text;
    let scheme_end = rest.find([':', '/', '?', '#']);
    let scheme = match scheme_end {
        Some(i) if i > 0 && rest.as_bytes()[i] == b':' => {
            let scheme = &rest[..i];
            rest = &rest[i + 1..];
            Some(scheme)
        }
        _ => None,
    };
    let authority = if let Some(after) = rest.strip_prefix("//") {
        let end = after.find(['/', '?', '#']).unwrap_or(after.len());
        rest = &after[end..];
        Some(&after[..end])
    } else {
        None
    };
    let path_end = rest.find(['?', '#']).unwrap_or(rest.len());
    let path = &rest[..path_end];
    rest = &rest[path_end..];
    let query = if let Some(after) = rest.strip_prefix('?') {
        let end = after.find('#').unwrap_or(after.len());
        rest = &after[end..];
        Some(&after[..end])
    } else {
        None
    };
    let fragment = rest.strip_prefix('#');
    Parts {
        scheme,
        authority,
        path,
        query,
        fragment,
    }
}

/// `resolveIri`: resolves an IRI reference against `base` (RFC 3986 §5.2.2). Absolute references
/// come back unchanged; without a base, relative references stay relative.
pub fn resolve_iri(reference: &str, base: Option<&str>) -> String {
    let Some(base) = base.filter(|b| !b.is_empty()) else {
        return reference.to_owned();
    };
    if is_absolute_iri(reference) {
        return reference.to_owned();
    }
    let r = parts(reference);
    let b = parts(base);
    let mut authority = b.authority;
    let mut query = r.query;
    let path = if r.authority.is_some() {
        authority = r.authority;
        remove_dot_segments(r.path)
    } else if r.path.is_empty() {
        query = r.query.or(b.query);
        b.path.to_owned()
    } else if r.path.starts_with('/') {
        remove_dot_segments(r.path)
    } else {
        // Merge (§5.2.3): a base with an authority and an empty path merges under "/".
        let merged = if b.authority.is_some() && b.path.is_empty() {
            format!("/{}", r.path)
        } else {
            let cut = b.path.rfind('/').map_or(0, |i| i + 1);
            format!("{}{}", &b.path[..cut], r.path)
        };
        remove_dot_segments(&merged)
    };
    let mut out = String::new();
    if let Some(scheme) = b.scheme {
        out.push_str(scheme);
        out.push(':');
    }
    if let Some(authority) = authority {
        out.push_str("//");
        out.push_str(authority);
    }
    out.push_str(&path);
    if let Some(query) = query {
        out.push('?');
        out.push_str(query);
    }
    if let Some(fragment) = r.fragment {
        out.push('#');
        out.push_str(fragment);
    }
    out
}

/// `/(?:^|\/)\.\.?(?:\/|$)/`.
fn has_dot_segment(path: &str) -> bool {
    path.split('/')
        .any(|segment| segment == "." || segment == "..")
}

/// RFC 3986 §5.2.4, literally: `/a/b/../c/./d` → `/a/c/d`.
pub fn remove_dot_segments(path: &str) -> String {
    if !has_dot_segment(path) {
        return path.to_owned();
    }
    let mut input = path.to_owned();
    let mut output = String::new();
    let drop_last_segment = |output: &mut String| {
        let cut = output.rfind('/').unwrap_or(0);
        output.truncate(cut);
    };
    while !input.is_empty() {
        if let Some(rest) = input.strip_prefix("../") {
            input = rest.to_owned();
        } else if let Some(rest) = input.strip_prefix("./") {
            input = rest.to_owned();
        } else if input.starts_with("/./") {
            input = input[2..].to_owned();
        } else if input == "/." {
            input = "/".to_owned();
        } else if input.starts_with("/../") {
            input = input[3..].to_owned();
            drop_last_segment(&mut output);
        } else if input == "/.." {
            input = "/".to_owned();
            drop_last_segment(&mut output);
        } else if input == "." || input == ".." {
            input.clear();
        } else {
            // `input.indexOf('/', 1)`: past the first character, which may be a slash.
            let first = input.chars().next().map_or(0, char::len_utf8);
            let end = input[first..].find('/').map_or(input.len(), |i| i + first);
            output.push_str(&input[..end]);
            input = input[end..].to_owned();
        }
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_as_rfc_3986() {
        let base = Some("http://a/b/c/d;p?q");
        for (reference, expected) in [
            ("g", "http://a/b/c/g"),
            ("./g", "http://a/b/c/g"),
            ("g/", "http://a/b/c/g/"),
            ("/g", "http://a/g"),
            ("//g", "http://g"),
            ("?y", "http://a/b/c/d;p?y"),
            ("#s", "http://a/b/c/d;p?q#s"),
            ("", "http://a/b/c/d;p?q"),
            ("../..", "http://a/"),
            ("../../../g", "http://a/g"),
            ("g;x=1/../y", "http://a/b/c/y"),
            ("http:g", "http:g"),
        ] {
            assert_eq!(resolve_iri(reference, base), expected, "{reference}");
        }
        assert_eq!(resolve_iri("../b", None), "../b");
        assert_eq!(resolve_iri("x", Some("http://e")), "http://e/x");
        assert!(is_absolute_iri("urn:x") && !is_absolute_iri("_:b") && !is_absolute_iri("1a:b"));
    }
}
