# decode-uri-component compatibility build

This is upstream decode-uri-component **0.5.1**, with its MIT license. It fixes
GHSA-vcc3-ghjq-m6fr and GHSA-qr28-fpjm-wq7f by scanning malformed percent-encoded
input in one pass and never rescanning decoded output.

Expo SDK 57 uses query-string 7, which requires a CommonJS function. Upstream
0.5.1 exports an ESM default; a direct version override breaks that contract.
The npm override selects this local package for every consumer, including Node
build tooling and Metro's web and Android bundles.

Only two compatibility changes were made to upstream index.js:

1. Replace `export default function` with `module.exports = function`.
2. Preserve 0.2.2's `+` to space conversion before decoding.

Provenance: https://registry.npmjs.org/decode-uri-component/-/decode-uri-component-0.5.1.tgz

- Tarball integrity: `sha512-vWHQkXgg2cE3BB4rR0c+PYw9BCQzLoNIRMI7AunIkZst74tw/vpPp7VLoYtsR/cy1f55g3XDWUslfeCZjiZJyA==`
- Original index.js SHA-256: `6a86ac891edf15c5efa0841ebb31935e3669d58b98318b57d7b08a4530317cb0`

Remove this override when a supported Expo Router uses a fixed decoder with a
compatible module format. Keep the malformed-input regression tests.
