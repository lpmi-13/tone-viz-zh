# Speaker-selection artifacts

Only the diagnostic corpus and this explanation are present in a fresh checkout. The offline pipeline writes the screening manifest, measurements, gate decisions, deterministic ranking, selected speakers, alternates, acoustic map, and HTML report here.

`npm run content:validate:release` refuses to publish the configuration fixture. It succeeds only after the real artifacts select exactly three published `zf` and three published `zm` model identities and the full corpus has measured audio, alignment, analysis, and checksums.
