# Third-party software

The browser download engine uses **Mediabunny 1.62.1**, Copyright 2026-present
Vanilagy and contributors, under the Mozilla Public License 2.0 (MPL-2.0).
The complete license is included at [`licenses/mediabunny-MPL-2.0.txt`](licenses/mediabunny-MPL-2.0.txt).
Mediabunny's source files are unmodified. Executable code is bundled locally;
the engine does not download executable code at runtime.

Corresponding public source for this exact package is included in the `src/`
directory of the versioned npm distribution:

- Source distribution: <https://registry.npmjs.org/mediabunny/-/mediabunny-1.62.1.tgz>
- Upstream source repository: <https://github.com/Vanilagy/mediabunny>
- Registry integrity (also pinned in `package-lock.json`):
  `sha512-lYzeerDwo9QLhBCipqQDXOSV7InvaIFplllZQviPO5rPwH+IUr8M1uvumk1olIUgMRGkPiInRriv25WFErUgMw==`

MPL-covered source, including any future modifications to those files, remains
available under MPL-2.0. These notices and the license must accompany distributed
extension artifacts that contain the library. The rest of this project's source
is separate from the unmodified library source.

The dependency also installs TypeScript declaration packages
`@types/dom-webcodecs` and `@types/dom-mediacapture-transform`; these declarations
are build-time types and are not executable browser bundle code.

## Nunito Sans

The popup uses an unmodified, locally hosted Latin WOFF2 subset of Nunito Sans, Copyright 2016 The Nunito Sans Project Authors, under the SIL Open Font License 1.1. The complete license is included at `licenses/nunito-sans-OFL.txt`.

Font source: https://fonts.googleapis.com/css2?family=Nunito+Sans:wght@400..800&display=swap

Upstream license: https://github.com/google/fonts/blob/main/ofl/nunitosans/OFL.txt

No font requests are made at runtime.
