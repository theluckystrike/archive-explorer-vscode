# Changelog

## 0.1.0 (2026-11-07)

- First release. Opens ZIP, JAR, VSIX, TAR, TAR.GZ, TGZ and GZ files as a folder list with sizes, packed sizes and compression ratios.
- An Archive Explorer tree in the side bar, with search, Extract, Copy Path and Open to the Side.
- Entries open read-only in normal editor tabs, so code gets syntax colors and images open in the image preview. Nested archives open as archives.
- Safe extraction of one file, a folder or the whole archive. Names with ".." or absolute paths are never written. Size and count limits stop zip bombs.
- Sponsor and More free viewers links in the status line, which you can hide with `archiveExplorer.showSupportLinks`.
