# Development environment

The repository development default is uv-managed CPython 3.14 with the GIL enabled. The
[`pyproject.toml`](../pyproject.toml) package floor remains Python 3.10; `.python-version` selects a
development interpreter and does not narrow the published package requirement.

## Default environment

Windows and Linux use the same uv commands:

```bash
uv python install 3.14
uv sync --frozen
```

`.python-version` deliberately says `3.14+gil` so uv cannot silently select a free-threaded build.
The install target remains `3.14`: uv distributes the normal GIL build under that target and does
not publish a separate `3.14+gil` download target.

Verify the selected interpreter after importing NumPy:

```bash
uv run python -c "import sys, sysconfig, numpy; assert sysconfig.get_config_var('Py_GIL_DISABLED') != 1; assert sys._is_gil_enabled(); print(sys.version, numpy.__version__)"
```

The normal project environment remains `.venv` on both platforms.

## Free-threaded compatibility environment

Install the optional CPython 3.14 free-threaded build with its uv `t` suffix:

```bash
uv python install 3.14t
```

Run it in an isolated uv environment so the compatibility check does not replace the default
`.venv`:

```bash
uv run --isolated --frozen --python 3.14t python -c "import sys, sysconfig, numpy; assert sysconfig.get_config_var('Py_GIL_DISABLED') == 1; assert not sys._is_gil_enabled(); print(sys.version, numpy.__version__)"
uv run --isolated --frozen --python 3.14t python -m pytest -q
```

The assertion is performed after importing NumPy so an incompatible extension cannot silently
re-enable the GIL without making the check fail. The free-threaded environment is a compatibility
and concurrency test target, not the default runtime.

## Transport thread decision

Scene Engine uses one ordinary Python thread per Runtime transport sender on both Windows and
Linux. This is the right boundary for potentially blocking socket or pipe I/O: it preserves the
exact immutable packet object and the existing transport handle, while a bounded queue gives the
runtime deterministic backpressure and finite shutdown. A process would require another IPC
protocol, copy or shared-memory ownership rules, duplicated failure recovery and platform-specific
handle transfer merely to reach the real transport; it would not improve World or NumPy isolation
because those objects are deliberately never sent to the worker.

CPython 3.14's normal build still has the GIL, but this transport design does not require
CPU-parallel Python bytecode: blocking I/O releases the GIL and the worker performs no simulation.
CPython 3.14t is genuinely free-threaded on both supported platforms when `Py_GIL_DISABLED == 1`
and `sys._is_gil_enabled()` is false. The same queue/lock/epoch protocol is required in both builds;
free-threading is an additional race-safety target, not a reason to move authoritative mutation off
the Runtime thread.

## Why the repository does not use Conda

uv already owns interpreter installation, virtual environments, dependency locking and project
synchronization on Windows and Linux. The current native dependency, NumPy, has locked CPython
3.14 and 3.14t wheels for both platforms. Adding Conda would introduce a second resolver and a
second environment definition without supplying a missing runtime dependency, so `uv.lock`
remains the sole Python environment lock.
