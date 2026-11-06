# Extract safely

Extract... works on one file, a folder or the whole archive.

- Entry names with `..` or an absolute path are listed with a warning and never written.
- One extraction writes at most 2 GB by default (`archiveExplorer.maxUnpackedMB`).
- An entry that unpacks to more than its header says is stopped.
- Existing files are kept unless you choose Overwrite.

Links inside TAR files are listed but not created.
