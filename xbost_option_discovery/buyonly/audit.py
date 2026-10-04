"""Detailed, structured audit logging for the buy-only engine.

Purpose
-------
Every decision the engine makes is recorded with the reason attached, so a run can
be reviewed afterwards without re-deriving anything. This is deliberately verbose:
the goal is that a reviewer can answer "why was this trade taken, on this contract,
in this regime, and what stopped it?" by reading the log alone.

Three sinks, one stream
-----------------------
  stdout        human-readable lines (streamed live to the UI over SSE)
  run_log.txt   the same lines, persisted for offline review
  audit.jsonl   one JSON object per event, for machine review / diffing between runs

Event kinds
-----------
  RUN        run configuration and dataset identity
  DATA       ingestion, moneyness audit, underlying provenance
  FEATURE    feature construction and coverage
  REGIME     regime distribution and the authorised-hypothesis map
  SIGNAL     every signal each detector produced
  GATE       every signal the adaptive engine blocked, with the reason
  SELECT     contract selection: candidate set, ATM reference, chosen contract
  TRADE      entry, exit reason, MFE/MAE, breakeven/lock state, costs
  STAT       bootstrap CI and the signal re-timing null
  SWEEP      parameter sensitivity rows
  VERDICT    the final honest statement

Verbosity levels
----------------
`--log-level` selects how much is emitted:
  info    stage-level lines and all trade/gate records
  debug   adds per-signal feature snapshots (every detector's trigger values)
  trace   adds the full candidate-contract enumeration for every selection
"""
import json
import os
import sys
import time

LEVELS = {"quiet": 0, "info": 1, "debug": 2, "trace": 3}


class RunLogger:
    """Fan-out logger: stdout + text file + JSONL file."""

    def __init__(self, outdir=None, level="info", echo=True, run_id=None):
        self.level = LEVELS.get(str(level).lower(), 1)
        self.level_name = str(level).lower()
        self.echo = bool(echo) and self.level > 0
        self.t0 = time.time()
        self.run_id = run_id or ("BO-" + time.strftime("%Y%m%d-%H%M%S"))
        self.outdir = outdir
        self.text_path = None
        self.jsonl_path = None
        self.lines = []            # retained for the UI bundle
        self.counts = {}
        if outdir:
            try:
                os.makedirs(outdir, exist_ok=True)
                self.text_path = os.path.join(outdir, "run_log.txt")
                self.jsonl_path = os.path.join(outdir, "audit.jsonl")
            except Exception:
                self.text_path = self.jsonl_path = None

    # -- internals ------------------------------------------------------
    def _stamp(self):
        return f"[+{time.time() - self.t0:7.2f}s]"

    def _write_text(self, line):
        if not self.text_path:
            return
        try:
            with open(self.text_path, "a") as f:
                f.write(line + "\n")
        except Exception:
            pass

    def _write_json(self, obj):
        if not self.jsonl_path:
            return
        try:
            with open(self.jsonl_path, "a") as f:
                f.write(json.dumps(obj, default=str) + "\n")
        except Exception:
            pass

    # -- public ---------------------------------------------------------
    def event(self, kind, message, **fields):
        """Record one structured event. `kind` is one of the documented kinds."""
        if self.level <= 0:
            # `quiet` means record nothing at all: no stdout, no file, no
            # retained lines. Otherwise a "quiet" run would still fill disk and
            # still ship a full log inside the bundle, which is not quiet.
            return None
        self.counts[kind] = self.counts.get(kind, 0) + 1
        obj = {"t": round(time.time() - self.t0, 4), "kind": kind,
               "run_id": self.run_id, "message": message}
        if fields:
            obj["fields"] = {k: v for k, v in fields.items()}
        self._write_json(obj)
        extra = ""
        if fields:
            extra = " " + " ".join(f"{k}={_short(v)}" for k, v in fields.items())
        line = f"{self._stamp()} {kind:<8} {message}{extra}"
        self.lines.append(line)
        if len(self.lines) > 20000:      # bound memory on huge runs
            del self.lines[:5000]
        self._write_text(line)
        if self.echo:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()
        return obj

    def at(self, min_level, kind, message, **fields):
        """Emit only when the configured verbosity reaches `min_level`."""
        if self.level >= min_level:
            return self.event(kind, message, **fields)
        return None

    def rule(self, title=""):
        """A visual separator in the text log."""
        if self.level <= 0:
            return
        line = f"{self._stamp()} {'':-<8} {'':-<26} {title}"
        self.lines.append(line)
        self._write_text(line)
        if self.echo:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def run(self, message, **fields):
        return self.event("RUN", message, **fields)

    def data(self, message, **fields):
        return self.event("DATA", message, **fields)

    def feature(self, message, **fields):
        return self.event("FEATURE", message, **fields)

    def regime(self, message, **fields):
        return self.event("REGIME", message, **fields)

    def signal(self, message, **fields):
        return self.event("SIGNAL", message, **fields)

    def gate(self, message, **fields):
        return self.event("GATE", message, **fields)

    def select(self, message, **fields):
        return self.event("SELECT", message, **fields)

    def trade(self, message, **fields):
        return self.event("TRADE", message, **fields)

    def stat(self, message, **fields):
        return self.event("STAT", message, **fields)

    def sweep(self, message, **fields):
        return self.event("SWEEP", message, **fields)

    def verdict(self, message, **fields):
        return self.event("VERDICT", message, **fields)

    def summary_counts(self):
        return dict(sorted(self.counts.items()))


def _short(v, width=60):
    s = str(v)
    return s if len(s) <= width else s[:width] + "…"