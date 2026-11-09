//! The message `JSON.parse` throws for text that is not JSON, as V8 (Node 22 and later) words
//! it: `kgdiff apply` quotes it for a delta that is not valid JSON (`"d.json" is not valid
//! JSON: Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7).`).
//!
//! This is JavaScript-specific and belongs with `kgdiff_core::js` by RFC 0002's rule; it lives
//! here because only the CLI quotes it and phase 3 keeps to the CLI's crates. Positions and
//! columns count UTF-16 units; `\r\n`, `\r` and `\n` end lines; an unexpected character is
//! quoted with up to ten units of context on each side.

/// V8's message for `text`, or `None` when `JSON.parse` accepts it (lone surrogate escapes
/// included: kgdiff refuses those itself, RFC 0002 D-2).
pub fn parse_error(text: &str) -> Option<String> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut checker = Checker { s: &units, pos: 0 };
    let error = checker.document().err()?;
    Some(checker.message(error))
}

#[derive(Clone, Copy, Debug)]
enum Error {
    /// `Unexpected end of JSON input`.
    EndOfInput,
    /// An unexpected character, worded by its token class.
    Unexpected,
    /// A message with a position.
    At(&'static str),
}

struct Checker<'a> {
    s: &'a [u16],
    pos: usize,
}

const QUOTE: u16 = b'"' as u16;
const BACKSLASH: u16 = b'\\' as u16;

fn is_digit(u: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&u)
}

fn is_hex(u: u16) -> bool {
    is_digit(u)
        || (u16::from(b'a')..=u16::from(b'f')).contains(&u)
        || (u16::from(b'A')..=u16::from(b'F')).contains(&u)
}

fn is(u: Option<u16>, c: u8) -> bool {
    u == Some(u16::from(c))
}

#[derive(Clone, Copy)]
enum Frame {
    /// Inside an array, after a value.
    Array,
    /// Inside an object, after a value.
    Object,
}

impl Checker<'_> {
    fn peek(&self) -> Option<u16> {
        self.s.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(0x20 | 0x09 | 0x0a | 0x0d)) {
            self.pos += 1;
        }
    }

    fn document(&mut self) -> Result<(), Error> {
        let mut stack: Vec<Frame> = Vec::new();
        'value: loop {
            // A value.
            self.skip_whitespace();
            let Some(c) = self.peek() else {
                return Err(Error::EndOfInput);
            };
            match u8::try_from(c).unwrap_or(0) {
                b'"' => self.string()?,
                b'-' | b'0'..=b'9' => self.number()?,
                b't' => self.literal("true")?,
                b'f' => self.literal("false")?,
                b'n' => self.literal("null")?,
                b'[' => {
                    self.pos += 1;
                    self.skip_whitespace();
                    if is(self.peek(), b']') {
                        self.pos += 1;
                    } else {
                        stack.push(Frame::Array);
                        continue 'value;
                    }
                }
                b'{' => {
                    self.pos += 1;
                    self.skip_whitespace();
                    match self.peek() {
                        Some(QUOTE) => {
                            self.member_name()?;
                            stack.push(Frame::Object);
                            continue 'value;
                        }
                        Some(u) if u == u16::from(b'}') => self.pos += 1,
                        _ => return Err(Error::At("Expected property name or '}' in JSON")),
                    }
                }
                _ => return Err(Error::Unexpected),
            }
            // After a value: close containers, or go on to the next value.
            loop {
                let Some(frame) = stack.last().copied() else {
                    self.skip_whitespace();
                    if self.peek().is_some() {
                        return Err(Error::At("Unexpected non-whitespace character after JSON"));
                    }
                    return Ok(());
                };
                self.skip_whitespace();
                match frame {
                    Frame::Array => match self.peek() {
                        Some(u) if u == u16::from(b',') => {
                            self.pos += 1;
                            continue 'value;
                        }
                        Some(u) if u == u16::from(b']') => {
                            self.pos += 1;
                            stack.pop();
                        }
                        _ => {
                            return Err(Error::At(
                                "Expected ',' or ']' after array element in JSON",
                            ));
                        }
                    },
                    Frame::Object => match self.peek() {
                        Some(u) if u == u16::from(b',') => {
                            self.pos += 1;
                            self.skip_whitespace();
                            if self.peek() != Some(QUOTE) {
                                return Err(Error::At(
                                    "Expected double-quoted property name in JSON",
                                ));
                            }
                            self.member_name()?;
                            continue 'value;
                        }
                        Some(u) if u == u16::from(b'}') => {
                            self.pos += 1;
                            stack.pop();
                        }
                        _ => {
                            return Err(Error::At(
                                "Expected ',' or '}' after property value in JSON",
                            ));
                        }
                    },
                }
            }
        }
    }

    /// A property name and its colon.
    fn member_name(&mut self) -> Result<(), Error> {
        self.string()?;
        self.skip_whitespace();
        if !is(self.peek(), b':') {
            return Err(Error::At("Expected ':' after property name in JSON"));
        }
        self.pos += 1;
        Ok(())
    }

    fn string(&mut self) -> Result<(), Error> {
        self.pos += 1;
        loop {
            let Some(c) = self.peek() else {
                return Err(Error::At("Unterminated string in JSON"));
            };
            match c {
                QUOTE => {
                    self.pos += 1;
                    return Ok(());
                }
                BACKSLASH => {
                    self.pos += 1;
                    let Some(e) = self.peek() else {
                        return Err(Error::EndOfInput);
                    };
                    match u8::try_from(e).unwrap_or(0) {
                        b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' => self.pos += 1,
                        b'u' => {
                            self.pos += 1;
                            for _ in 0..4 {
                                if !self.peek().is_some_and(is_hex) {
                                    return Err(Error::At("Bad Unicode escape in JSON"));
                                }
                                self.pos += 1;
                            }
                        }
                        _ => return Err(Error::At("Bad escaped character in JSON")),
                    }
                }
                c if c < 0x20 => {
                    return Err(Error::At("Bad control character in string literal in JSON"));
                }
                _ => self.pos += 1,
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.pos;
        while self.peek().is_some_and(is_digit) {
            self.pos += 1;
        }
        self.pos - start
    }

    fn number(&mut self) -> Result<(), Error> {
        if is(self.peek(), b'-') {
            self.pos += 1;
            if !self.peek().is_some_and(is_digit) {
                return Err(Error::At("No number after minus sign in JSON"));
            }
        }
        if is(self.peek(), b'0') {
            self.pos += 1;
            if self.peek().is_some_and(is_digit) {
                return Err(Error::At("Unexpected number in JSON"));
            }
        } else {
            self.digits();
        }
        if is(self.peek(), b'.') {
            self.pos += 1;
            if self.digits() == 0 {
                return Err(Error::At("Unterminated fractional number in JSON"));
            }
        }
        if is(self.peek(), b'e') || is(self.peek(), b'E') {
            self.pos += 1;
            if is(self.peek(), b'+') || is(self.peek(), b'-') {
                self.pos += 1;
            }
            if self.digits() == 0 {
                return Err(Error::At("Exponent part is missing a number in JSON"));
            }
        }
        Ok(())
    }

    fn literal(&mut self, word: &str) -> Result<(), Error> {
        for expected in word.encode_utf16() {
            match self.peek() {
                None => return Err(Error::EndOfInput),
                Some(u) if u == expected => self.pos += 1,
                Some(_) => return Err(Error::Unexpected),
            }
        }
        Ok(())
    }

    /// `(line N column M)` of the current position.
    fn location(&self) -> (usize, usize) {
        let (mut line, mut line_start, mut i) = (1, 0, 0);
        while i < self.pos {
            if self.s[i] == 0x0d && i + 1 < self.pos && self.s[i + 1] == 0x0a {
                i += 1;
            }
            if self.s[i] == 0x0d || self.s[i] == 0x0a {
                line += 1;
                line_start = i + 1;
            }
            i += 1;
        }
        (line, 1 + self.pos - line_start)
    }

    fn message(&self, error: Error) -> String {
        let at = |what: &str| {
            let (line, column) = self.location();
            format!(
                "{what} at position {} (line {line} column {column})",
                self.pos
            )
        };
        match error {
            Error::EndOfInput => "Unexpected end of JSON input".to_owned(),
            Error::At(what) => at(what),
            Error::Unexpected => {
                let c = self.s[self.pos];
                // The token class of the character decides the wording.
                if c == QUOTE {
                    return at("Unexpected string in JSON");
                }
                if is_digit(c) || c == u16::from(b'-') {
                    return at("Unexpected number in JSON");
                }
                let source = String::from_utf16_lossy(self.s);
                if matches!(
                    source.as_str(),
                    "NaN" | "undefined" | "Infinity" | "[object Object]"
                ) {
                    return format!("\"{source}\" is not valid JSON");
                }
                let token = String::from_utf16_lossy(&[c]);
                let (len, pos, k) = (self.s.len(), self.pos, 10);
                let quote = |a: usize, b: usize| String::from_utf16_lossy(&self.s[a..b.min(len)]);
                if len <= 2 * k {
                    format!("Unexpected token '{token}', \"{source}\" is not valid JSON")
                } else if pos < k {
                    format!(
                        "Unexpected token '{token}', \"{}\"... is not valid JSON",
                        quote(0, pos + k)
                    )
                } else if pos < len - k {
                    format!(
                        "Unexpected token '{token}', ...\"{}\"... is not valid JSON",
                        quote(pos - k, pos + k)
                    )
                } else {
                    format!(
                        "Unexpected token '{token}', ...\"{}\" is not valid JSON",
                        quote(pos - k, len)
                    )
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::parse_error;

    /// Messages recorded from Node 24.
    #[test]
    fn words_errors_as_v8() {
        let cases: &[(&str, &str)] = &[
            ("", "Unexpected end of JSON input"),
            ("x", "Unexpected token 'x', \"x\" is not valid JSON"),
            (
                "{",
                "Expected property name or '}' in JSON at position 1 (line 1 column 2)",
            ),
            (
                "{\"a\"",
                "Expected ':' after property name in JSON at position 4 (line 1 column 5)",
            ),
            ("{\"a\":", "Unexpected end of JSON input"),
            (
                "{\"a\":1",
                "Expected ',' or '}' after property value in JSON at position 6 (line 1 column 7)",
            ),
            (
                "{\"a\":1,}",
                "Expected double-quoted property name in JSON at position 7 (line 1 column 8)",
            ),
            (
                "[1 2]",
                "Expected ',' or ']' after array element in JSON at position 3 (line 1 column 4)",
            ),
            (
                "1 2",
                "Unexpected non-whitespace character after JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"abc",
                "Unterminated string in JSON at position 4 (line 1 column 5)",
            ),
            (
                "\"a\nb\"",
                "Bad control character in string literal in JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"\\x\"",
                "Bad escaped character in JSON at position 2 (line 1 column 3)",
            ),
            (
                "\"\\u12\"",
                "Bad Unicode escape in JSON at position 5 (line 1 column 6)",
            ),
            ("\"abc\\", "Unexpected end of JSON input"),
            (
                "-x",
                "No number after minus sign in JSON at position 1 (line 1 column 2)",
            ),
            (
                "1.x",
                "Unterminated fractional number in JSON at position 2 (line 1 column 3)",
            ),
            (
                "1e+",
                "Exponent part is missing a number in JSON at position 3 (line 1 column 4)",
            ),
            (
                "-01",
                "Unexpected number in JSON at position 2 (line 1 column 3)",
            ),
            ("trux", "Unexpected token 'x', \"trux\" is not valid JSON"),
            ("fals", "Unexpected end of JSON input"),
            ("[1,]", "Unexpected token ']', \"[1,]\" is not valid JSON"),
            ("NaN", "\"NaN\" is not valid JSON"),
            (" NaN", "Unexpected token 'N', \" NaN\" is not valid JSON"),
            (
                "abcdefghijklmnopqrstu",
                "Unexpected token 'a', \"abcdefghij\"... is not valid JSON",
            ),
            (
                "{\"a\":[1,2,3,4,5,6,7,8,9,x]}",
                "Unexpected token 'x', ...\"5,6,7,8,9,x]}\" is not valid JSON",
            ),
            (
                "\u{1F600}",
                "Unexpected token '\u{FFFD}', \"\u{1F600}\" is not valid JSON",
            ),
            (
                "[\"\u{1F600}\" x]",
                "Expected ',' or ']' after array element in JSON at position 6 (line 1 column 7)",
            ),
            (
                "{\"a\":1}\n\n x",
                "Unexpected non-whitespace character after JSON at position 10 (line 3 column 2)",
            ),
            (
                "\r\n\rx",
                "Unexpected token 'x', \"\r\n\rx\" is not valid JSON",
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(parse_error(text).as_deref(), Some(*expected), "{text:?}");
        }
        assert_eq!(parse_error(" {\"a\":[1,true,null,\"\\ud800\"]} "), None);
    }
}
