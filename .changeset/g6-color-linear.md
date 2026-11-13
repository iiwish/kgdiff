---
'@kgdiff/g6': patch
---

Reading an `rgb()` / `rgba()` color takes time linear in its length: a long `rgb(` with no closing parenthesis, from a host's theme, was quadratic before.
