# ZIP Viewer & Archive Explorer

Look inside ZIP, JAR, VSIX, TAR, TAR.GZ and GZ files in VS Code, open any file in an editor tab, and extract only what you need without unpacking the rest.

![A release ZIP open in ZIP Viewer & Archive Explorer, with folders, sizes, packed sizes and ratios, and the Archive Explorer tree in the side bar](images/archive-editor.png)

*Screenshot from a real VS Code 1.142 window running the packaged extension on `web-app-release.zip`, a sample made by `scripts/make-samples.js`.*

- See what is inside before you unpack. Folders, sizes, packed sizes, compression ratios and dates, for archives with up to 200,000 entries.
- Open any entry in a normal tab. Code gets syntax colors, images open in the image preview, and a ZIP inside a ZIP opens as another archive. Entries are read-only.
- Extract safely. Names with `..` or an absolute path are never written, and size limits stop zip bombs before they fill your disk.

## Quick start

1. Install the extension.
2. Click a `.zip`, `.jar`, `.vsix`, `.tar`, `.tar.gz`, `.tgz` or `.gz` file in the Explorer.

To browse an archive in the side bar instead, right-click it and choose Browse in Archive Explorer.

## What you can do

| Task | How |
|---|---|
| Browse folders | Double-click a folder, use the path bar at the top, or press Backspace to go up. |
| Sort | Click Name, Size, Packed, Ratio or Modified. Folders stay on top. |
| Search names | Type in the search box. Plain text matches anywhere in the path, and `*` and `?` work as wildcards, for example `*.class`. |
| Open an entry | Double-click it or press Enter. Open to the side puts it next to the archive. |
| Extract | Select a file or folder and click Extract..., or use Extract all... for the whole archive. One file goes through a save dialog, a folder through a folder picker. |
| Copy a path | Copy path (or Cmd+C / Ctrl+C) copies the path inside the archive. |
| Side bar tree | The Archive Explorer section of the Explorer lists every archive you opened, with search, Extract, Copy Path and Open to the Side on right-click. |

![Opening an image from the Archive Explorer tree. It shows in the VS Code image preview, with the path inside the archive in the breadcrumbs](images/tree-and-entry.png)

![Searching a ZIP for *.png lists both PNG files with their full paths](images/search-results.png)

## Supported files

| Type | Extensions | Notes |
|---|---|---|
| ZIP family | `.zip`, `.jar`, `.vsix` open by default. `.war`, `.ear`, `.whl`, `.nupkg`, `.apk`, `.aar`, `.xpi` and `.epub` open through Open in Archive Explorer. | Stored and Deflate entries, ZIP64, UTF-8 and old DOS names, self-extracting archives. |
| TAR | `.tar` | ustar, GNU long names and pax headers. Links are listed but not created. |
| TAR.GZ | `.tar.gz`, `.tgz` | Unpacked in memory up to the `maxUnpackedMB` limit. |
| GZ | `.gz` | One file. A `.gz` that holds a TAR opens as TAR.GZ. |

Entries open with the editor VS Code picks for their type. That includes other Zovo viewers when you have them, so a CSV inside a ZIP can open in the table viewer.

## Safety

![A zip bomb sample. The banner warns about a 1008:1 ratio, and opening a 600 MB entry is refused with a clear message](images/zip-bomb-warning.png)

- Zip slip. Entry names with `..`, a leading `/`, a drive letter or a NUL character are listed with a warning and skipped during extraction. The target path is checked again just before each write.
- Zip bombs. An extraction that would write more than `archiveExplorer.maxUnpackedMB` (2 GB by default) is refused before anything is written. An entry that unpacks to more than its header says is stopped. Very high compression ratios get a banner.
- Big archives. Archives with more than `archiveExplorer.maxEntries` entries (200,000 by default) are not read. Entries over `archiveExplorer.maxEntryMB` (512 MB) do not open in a tab but can still be extracted.
- Existing files are kept unless you choose Overwrite. The archive itself is never changed.

![A zip slip sample. Three entries with unsafe names are crossed out, and extracting writes only the safe file](images/zip-slip.png)

## Settings

| Setting | Default | What it does |
|---|---|---|
| `archiveExplorer.maxEntries` | 200000 | Most entries read from one archive, and most files written by one extraction. |
| `archiveExplorer.maxEntryMB` | 512 | Largest entry, in MB, that opens in an editor tab. |
| `archiveExplorer.maxUnpackedMB` | 2048 | Most data, in MB, that one extraction writes. Also the limit for unpacking a `.tar.gz` in memory. |
| `archiveExplorer.askForRating` | true | Ask one time for a Marketplace rating after a few days of use. |
| `archiveExplorer.showSupportLinks` | true | Show the small Sponsor and More free viewers links in the status line. |

![The same viewer in the Light Modern theme with a TAR file](images/light-theme.png)

## Privacy

The extension works offline. It makes no network calls and has no telemetry. Archives are read from disk with range reads, so a large ZIP or TAR is not loaded whole. The view runs under a strict Content Security Policy, and every name from an archive is shown as plain text.

## Known limits

- Compression methods other than Stored and Deflate (for example BZIP2, LZMA, Zstandard and Deflate64) are listed but not opened. Encrypted entries are listed but not opened.
- 7z, RAR, XZ and BZ2 files are not supported.
- A `.tar.gz` is unpacked in memory, up to 2 GB by default.
- Entries are read-only. Extract a file to change it.
- The size shown for a single `.gz` file comes from its header and is marked with ≈ until the file is opened.

## Support

Zovo extensions have no ads and no tracking, and sponsors pay for the time that goes into fixes and new viewers. You can sponsor the work on [GitHub Sponsors](https://github.com/sponsors/theluckystrike).

## More viewers by Zovo

- [CSV Viewer, Excel Viewer & Parquet Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.table-viewer-vscode) opens CSV, TSV, Excel and Parquet files as a sortable, filterable table.
- [PDF Viewer & PDF Reader with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.pdf-viewer-dark) reads PDFs with a real dark mode, search, an outline and thumbnails.
- [DOCX Viewer & Word Viewer with Dark Mode](https://marketplace.visualstudio.com/items?itemName=zovo.docx-viewer-vscode) previews Word and ODT files with dark mode, an outline and search.
- [PPTX Viewer & PowerPoint Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.pptx-slide-viewer) shows PowerPoint slides, thumbnails and speaker notes.
- [Large JSON Viewer & JSON Tree](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-json-tree-viewer) shows large JSON files as a searchable tree, copies JSONPath and turns arrays of objects into a table.
- [JSONL Viewer & NDJSON Table Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.zovo-jsonl-viewer) opens JSONL and NDJSON files as a table, as records or as a chat view.
- [SQLite Viewer & DB Viewer (Read-Only)](https://marketplace.visualstudio.com/items?itemName=zovo.sqlite-table-viewer) browses SQLite tables read-only and runs SELECT queries.
- [HDF5 & NetCDF Explorer (H5 Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.hdf5-netcdf-explorer) browses groups, attributes and values in HDF5 and NetCDF files and plots slices.
- [GGUF, Safetensors & NPY Viewer (NumPy Viewer)](https://marketplace.visualstudio.com/items?itemName=zovo.tensor-viewer) shows NPY, NPZ, Safetensors and GGUF tensors with stats and heatmaps.
- [MP4 Video Player & Video Preview with Sound](https://marketplace.visualstudio.com/items?itemName=zovo.video-preview-with-sound) plays MP4, MOV, MKV and WebM files with their sound.
- [DXF Viewer & CAD Viewer for 2D Drawings](https://marketplace.visualstudio.com/items?itemName=zovo.dxf-viewer) opens ASCII and binary DXF drawings with layers, measuring and PNG or SVG export.
- [AGENTS.md & CLAUDE.md Linter (Context Drift)](https://marketplace.visualstudio.com/items?itemName=zovo.context-drift) finds stale commands, paths and versions in AGENTS.md and CLAUDE.md files.
- [Agent Skills & Claude Skills (Skill Shelf)](https://marketplace.visualstudio.com/items?itemName=zovo.skill-shelf) lists, checks and toggles the Agent Skills that Claude Code, Codex and Cursor load.
- [Claude Code History & Codex History Viewer](https://marketplace.visualstudio.com/items?itemName=zovo.agent-session-viewer) browses and searches your local Claude Code and Codex sessions.
- [Claude Code Usage & Codex Usage Cost Meter](https://marketplace.visualstudio.com/items?itemName=zovo.ai-usage-meter) shows Claude Code and Codex tokens and estimated cost from your local session files.

Coming soon to the Marketplace, with the code on GitHub now.

- [EML Viewer & MBOX Email Viewer](https://github.com/theluckystrike/eml-viewer-vscode) reads EML, EMLX and MBOX email files with remote images blocked.
- [Audio Preview & Loudness Meter](https://github.com/theluckystrike/audio-preview-vscode) plays audio files with a waveform, a spectrogram and LUFS loudness.
- [Graphviz Preview & DOT Viewer](https://github.com/theluckystrike/graphviz-preview-vscode) shows a live preview of DOT files and exports SVG or PNG.
- [TIFF Viewer (16-bit, Float, GeoTIFF)](https://github.com/theluckystrike/tiff-viewer-vscode) opens 16-bit, float, multi-page and GeoTIFF images.
- [Avro Viewer, Arrow Viewer & Feather Viewer](https://github.com/theluckystrike/arrow-avro-viewer-vscode) opens Avro, Arrow and Feather files as a paged table.
- [3D Model Viewer (GLB, glTF, STL, OBJ, PLY)](https://github.com/theluckystrike/model-viewer-vscode) views GLB, glTF, STL, OBJ, PLY and 3MF models.
- [PKL Viewer & Pickle Viewer](https://github.com/theluckystrike/pickle-viewer-vscode) opens Python pickle files without Python and never runs their code.
- [DICOM Viewer & NIfTI Viewer for CT and MRI](https://github.com/theluckystrike/dicom-nifti-viewer-vscode) opens CT and MRI scans, DICOM folders and NIfTI volumes with window presets and three views.
- [GCode Viewer & 3D Print Preview](https://github.com/theluckystrike/gcode-viewer-vscode) shows GCode toolpaths in 3D layer by layer, with print time and filament use.
- [EPUB Reader & EPUB Viewer](https://github.com/theluckystrike/epub-reader-vscode) reads EPUB books with a table of contents, search and light, sepia or dark themes.
- [File Viewers Pack](https://github.com/theluckystrike/zovo-file-viewers) installs the PDF, table, Word, PowerPoint, HDF5 and tensor viewers in one step.

## License

MIT. Bundles fflate (MIT). See THIRD-PARTY-NOTICES.md.
