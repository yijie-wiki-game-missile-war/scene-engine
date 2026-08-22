# Presentation Archive V3 cross-language fixture

`tests/tools/generate_presentation_archive_fixture.py` uses the production
Python `PresentationArchiveWriter` and V3 codec to regenerate these exact
bytes. Run it with `--check` to prove the committed fixture is current.

The valid archive contains two checkpoints and four authority correlations:

1. epoch 1: frame 1 at tick 0;
2. epoch 1: same-tick business-only, zero-frame correlation at tick 0;
3. epoch 1: frame 2 followed by an explicit producer reset at tick 1;
4. epoch 2: a new Bootstrap and frame 1 at the same committed tick 1.

`fixture-metadata.json` contains the exact valid MW v5 raw tape text, its
SHA-256, the parsed raw records, every correlation/frame mapping, the archive
manifest, and hashes for the standard three archive files. The `variants/`
directories are physically valid archives that fail semantic display
validation for the reason named by their directory. Packet/reader hard-limit
tests use header-only limit variants or apply smaller local limits to the valid
fixture, without committing an artificial multi-megabyte archive.
