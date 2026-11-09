//! Paths as Node's `node:path` handles them (`resolve`, `dirname`, `basename`, `join`): the
//! CLI resolves paths lexically against its working directory, so `a/../b` is `b` even when `a`
//! is a link, exactly as `@kgdiff/cli` does. POSIX rules everywhere but Windows, `path.win32`'s
//! there (drive letters, UNC roots, `\` and `/`).

#[cfg(windows)]
const SEPARATOR: char = '\\';
#[cfg(not(windows))]
const SEPARATOR: char = '/';

fn is_separator(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// The root of a path (`/`, `C:\`, `C:`, `\\server\share\`), as a byte length, and whether it
/// makes the path absolute.
fn root(path: &str) -> (usize, bool) {
    if !cfg!(windows) {
        return if path.starts_with('/') {
            (1, true)
        } else {
            (0, false)
        };
    }
    let bytes = path.as_bytes();
    let sep = |i: usize| bytes.get(i).is_some_and(|&b| b == b'/' || b == b'\\');
    if sep(0) && sep(1) {
        // `\\server\share\`
        let mut i = 2;
        let mut parts = 0;
        while i < bytes.len() && parts < 2 {
            let start = i;
            while i < bytes.len() && !sep(i) {
                i += 1;
            }
            if i == start {
                break;
            }
            parts += 1;
            if parts < 2 && sep(i) {
                i += 1;
            }
        }
        if parts == 2 {
            return (if sep(i) { i + 1 } else { i }, true);
        }
        return (1, true);
    }
    if sep(0) {
        return (1, true);
    }
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return if sep(2) { (3, true) } else { (2, false) };
    }
    (0, false)
}

/// `path.isAbsolute`.
pub fn is_absolute(path: &str) -> bool {
    root(path).1
}

/// Removes `.` and `..` segments and repeated separators from the part after the root.
fn normalize_segments(rest: &str, absolute: bool) -> String {
    let mut out: Vec<&str> = Vec::new();
    for segment in rest.split(is_separator) {
        match segment {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|last| *last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    out.join(&SEPARATOR.to_string())
}

/// The root as Node writes it: separators in their platform form.
fn root_text(path: &str, len: usize) -> String {
    path[..len]
        .chars()
        .map(|c| if is_separator(c) { SEPARATOR } else { c })
        .collect()
}

/// `path.resolve(cwd, path)`: `path` against `cwd`, normalized, without a trailing separator.
pub fn resolve(cwd: &str, path: &str) -> String {
    let (len, absolute) = root(path);
    let joined = if absolute {
        if cfg!(windows) && len == 1 {
            // `\x` on Windows: the root of the working directory's drive.
            let (cwd_len, _) = root(cwd);
            let drive = cwd[..cwd_len].trim_end_matches(is_separator);
            format!("{drive}{path}")
        } else {
            path.to_owned()
        }
    } else if path.is_empty() {
        cwd.to_owned()
    } else {
        format!("{cwd}{SEPARATOR}{path}")
    };
    let (len, absolute) = root(&joined);
    let rest = normalize_segments(&joined[len..], absolute);
    let root = root_text(&joined, len);
    if rest.is_empty() {
        if root.is_empty() {
            ".".to_owned()
        } else {
            root
        }
    } else {
        format!("{root}{rest}")
    }
}

/// `path.join(dir, name)`, for an absolute `dir`.
pub fn join(dir: &str, name: &str) -> String {
    resolve(dir, name)
}

/// `path.basename(path)`: the last segment, trailing separators ignored.
pub fn basename(path: &str) -> &str {
    let (len, _) = root(path);
    let rest = path[len..].trim_end_matches(is_separator);
    match rest.rfind(is_separator) {
        Some(i) => &rest[i + 1..],
        None => rest,
    }
}

/// `path.dirname(path)`: everything before the last segment (`.` when there is none).
pub fn dirname(path: &str) -> String {
    let (len, _) = root(path);
    let rest = path[len..].trim_end_matches(is_separator);
    match rest.rfind(is_separator) {
        Some(i) => {
            let parent = rest[..i].trim_end_matches(is_separator);
            if parent.is_empty() {
                path[..len].to_owned()
            } else {
                format!("{}{parent}", &path[..len])
            }
        }
        None if len > 0 => path[..len].to_owned(),
        None => ".".to_owned(),
    }
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn resolves_as_node_path_posix() {
        // Expectations from Node's path.posix.
        assert_eq!(resolve("/work", "a.json"), "/work/a.json");
        assert_eq!(resolve("/work", "./a/../b//c/"), "/work/b/c");
        assert_eq!(resolve("/work", "/x/../../y"), "/y");
        assert_eq!(resolve("/work", ""), "/work");
        assert_eq!(resolve("/", ".."), "/");
        assert_eq!(basename("a/b.json.gz"), "b.json.gz");
        assert_eq!(basename("a/b/"), "b");
        assert_eq!(basename("/"), "");
        assert_eq!(basename("a/.."), "..");
        assert_eq!(dirname("/work/a.json"), "/work");
        assert_eq!(dirname("/a"), "/");
        assert_eq!(dirname("a"), ".");
        assert_eq!(dirname("a/b/"), "a");
        assert_eq!(join("/work", "x.json"), "/work/x.json");
        assert!(is_absolute("/a") && !is_absolute("a"));
    }
}
