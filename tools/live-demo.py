"""Drive the fixture demo in a real Claude Code terminal and keep the evidence.

Fixture only: it types `/interview demo` and works the card with keys and
clicks. It never submits a prompt, so no model is called. Text and PNG captures
land in .runtime/live/<timestamp>/.

Needs pyte and Pillow: INTERVIEWER_PY_DEPS, else .runtime/python, else
../uinlay/.runtime/python. INTERVIEWER_CWD runs the session from another
(already trusted) folder; the plugin still loads from this checkout.
"""
from __future__ import annotations

import json
import os
import pty
import select
import shutil
import signal
import struct
import sys
import termios
import fcntl
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for candidate in (os.environ.get("INTERVIEWER_PY_DEPS"), ROOT / ".runtime" / "python", ROOT.parent / "uinlay" / ".runtime" / "python"):
    if candidate and Path(candidate).is_dir():
        sys.path.insert(0, str(candidate))
        break
import pyte  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

FONT_DIRS = [ROOT / ".runtime", ROOT.parent / "uinlay" / ".runtime", Path("/usr/share/fonts/truetype/dejavu")]
KEYS = {"enter": b"\r", "esc": b"\x1b", "right": b"\x1b[C", "left": b"\x1b[D", "ctrl-u": b"\x15", "ctrl-c": b"\x03"}


class Terminal:
    def __init__(self, columns: int = 150, rows: int = 46, extra: tuple[str, ...] = ()) -> None:
        self.columns, self.rows = columns, rows
        self.screen = pyte.Screen(columns, rows)
        self.stream = pyte.ByteStream(self.screen)
        claude = shutil.which("claude")
        if not claude:
            raise SystemExit("claude is not on PATH")
        args = [claude, "--plugin-dir", str(ROOT), "--settings", '{"tui":"fullscreen"}', *extra]
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(os.environ.get("INTERVIEWER_CWD") or ROOT)
            os.execvpe(args[0], args, dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", DISABLE_AUTOUPDATER="1"))
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))

    def pump(self, seconds: float = 0.4) -> None:
        deadline = time.monotonic() + seconds
        while (remaining := deadline - time.monotonic()) > 0:
            ready, _, _ = select.select([self.fd], [], [], min(remaining, 0.05))
            if not ready:
                continue
            try:
                data = os.read(self.fd, 65536)
            except OSError:
                return
            if b"\x1b[6n" in data:
                os.write(self.fd, f"\x1b[{self.screen.cursor.y + 1};{self.screen.cursor.x + 1}R".encode())
            if b"\x1b[c" in data or b"\x1b[0c" in data:
                os.write(self.fd, b"\x1b[?62;22c")
            self.stream.feed(data)

    def send(self, data: bytes, wait: float = 0.5) -> None:
        os.write(self.fd, data)
        self.pump(wait)

    def type(self, text: str, wait: float = 0.5) -> None:
        for char in text:
            self.send(char.encode(), 0.02)
        self.pump(wait)

    def key(self, name: str, wait: float = 0.5) -> None:
        self.send(KEYS[name], wait)

    def click(self, x: int, y: int, wait: float = 0.6) -> None:
        self.send(f"\x1b[<0;{x + 1};{y + 1}M".encode(), 0.05)
        self.send(f"\x1b[<0;{x + 1};{y + 1}m".encode(), wait)

    def text(self) -> str:
        return "\n".join(line.rstrip() for line in self.screen.display)

    def find(self, needle: str) -> tuple[int, int] | None:
        for y, line in enumerate(self.screen.display):
            if (x := line.find(needle)) >= 0:
                return x, y
        return None

    def wait_for(self, needle: str, timeout: float = 10) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            self.pump(0.25)
            if self.find(needle):
                return True
        return False

    def click_text(self, needle: str, dx: int = 1) -> bool:
        found = self.find(needle)
        if found:
            self.click(found[0] + dx, found[1])
        return bool(found)

    def composer(self) -> str:
        """The prompt line's text, so the driver never submits anything to the model."""
        for line in reversed(self.screen.display):
            if line.lstrip().startswith("❯"):
                return line.lstrip()[1:].strip()
        return ""

    def png(self, path: Path) -> None:
        def font(bold: bool):
            name = "DejaVuSansMono-Bold.ttf" if bold else "DejaVuSansMono.ttf"
            for folder in FONT_DIRS:
                if (folder / name).is_file():
                    return ImageFont.truetype(str(folder / name), 14)
            return ImageFont.load_default()

        def color(value: object, default: tuple[int, int, int]) -> tuple[int, int, int]:
            if isinstance(value, str) and len(value) == 6:
                try:
                    return tuple(int(value[i:i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]
                except ValueError:
                    return default
            return default

        regular, bold = font(False), font(True)
        cell_w, cell_h = max(1, round(regular.getlength("M"))), 18
        canvas = (24, 24, 27)
        image = Image.new("RGB", (cell_w * self.columns, cell_h * self.rows), canvas)
        draw = ImageDraw.Draw(image)
        for y in range(self.rows):
            for x in range(self.columns):
                cell = self.screen.buffer[y][x]
                fg, bg = color(cell.fg, (208, 208, 208)), color(cell.bg, canvas)
                if cell.reverse:
                    fg, bg = bg, fg
                if bg != canvas:
                    draw.rectangle([x * cell_w, y * cell_h, (x + 1) * cell_w - 1, (y + 1) * cell_h - 1], fill=bg)
                if cell.data and cell.data != " ":
                    draw.text((x * cell_w, y * cell_h + 1), cell.data, font=bold if cell.bold else regular, fill=fg)
        image.save(path)

    def close(self) -> None:
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.kill(self.pid, sig)
                time.sleep(0.4)
            except ProcessLookupError:
                return


def main() -> int:
    out = ROOT / ".runtime" / "live" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out.mkdir(parents=True, exist_ok=True)
    checks: list[dict[str, object]] = []
    term = Terminal()

    def check(name: str, passed: bool, note: str = "", png: bool = False) -> bool:
        (out / f"{len(checks) + 1:02d}-{name}.txt").write_text(term.text() + "\n", encoding="utf-8")
        if png:
            term.png(out / f"{len(checks) + 1:02d}-{name}.png")
        checks.append({"step": name, "passed": passed, "note": note})
        print(f"{'PASS' if passed else 'FAIL'} {name}{f' ({note})' if note else ''}", flush=True)
        return passed

    def safe_clear() -> None:
        if term.composer():
            term.key("ctrl-u")

    try:
        term.pump(4)
        if term.find("Quick safety check") or not term.wait_for("❯", 60):
            check("start", False, "trust or login needs an operator")
            return 1
        term.type("/interview demo")
        term.key("enter", 1.5)
        header = term.find("INTERVIEW · Rerank spec gaps") if term.wait_for("INTERVIEW · Rerank spec gaps", 10) else None
        # Docked beside the transcript: the card starts right of the transcript, not at column 0.
        docked = bool(header) and header[0] > 20 and bool(term.find("Q1 of 5"))
        check("demo-opens-docked", docked, f"card header at column {header[0] if header else '?'}", png=True)

        term.type("2", 1.0)
        ok = term.wait_for("Q2 of 5 · 1 recorded", 4)
        check("digit-answers-in-pane", ok, "native hotkey under the pane" if ok else f"composer holds {term.composer()!r}", png=True)
        safe_clear()

        clicked = term.click_text("Commit, push and open the PR", dx=2)
        check("click-option", clicked and term.wait_for("Q3 of 5 · 2 recorded", 4))

        term.type("w", 0.4)
        check("why-key", term.wait_for("Fixture:", 4) and bool(term.find("Why ask this")), "canned reply arrived", png=True)

        term.type("r", 0.4)
        term.type("run it", 0.6)
        if term.find("Reply: run it"):
            term.key("enter", 1.0)
            check("reply-reading", term.wait_for("Reads your reply as", 4), png=True)
        else:
            safe_clear()
            check("reply-reading", False, "the reply box did not receive the keys; nothing was submitted")

        check("confirm-reading", term.click_text("Confirm", dx=2) and term.wait_for("3 recorded", 4))
        check("accept-recommended", term.click_text("Accept recommended", dx=2) and term.wait_for("4 recorded", 4))
        sent = term.click_text("Send 4/5", dx=2) and term.wait_for("Sent: 4 answered, 1 left open.", 4)
        check("send-summary", sent and bool(term.find("never sent to Claude")), png=True)

        # The band fallback: a fresh round moved above the prompt fits without scrolling.
        term.key("esc", 0.6)
        safe_clear()
        term.type("/interview demo")
        term.key("enter", 1.5)
        term.key("esc", 0.6)
        safe_clear()
        term.type("/interview band")
        term.key("enter", 1.5)
        band = term.wait_for("f: Full card", 6)
        top = term.find("INTERVIEW · Rerank spec gaps")
        footer = term.find("Send 0/5")
        fits = bool(band and top and footer) and not any("┃" in line or "│" in line[-4:] for line in term.screen.display[top[1]:footer[1]]) if top and footer else False
        check("band-compact-fits", fits, "compact card, no scrollbar" if fits else "scrollbar or missing parts", png=True)
        check("full-card-button", term.click_text("Full card", dx=1) and term.wait_for("Preview · Copy from the request", 6), "opens the pane with the whole card", png=True)
        term.key("esc", 0.5)
        safe_clear()
        check("prompt-untouched", term.find("❯") is not None and term.composer() == "", "nothing typed into the composer")
    finally:
        (out / "checks.json").write_text(json.dumps(checks, indent=2) + "\n")
        term.close()
    passed = sum(bool(row["passed"]) for row in checks)
    print(f"{passed}/{len(checks)} passed; evidence {out}")
    return 0 if passed == len(checks) else 1


if __name__ == "__main__":
    raise SystemExit(main())
