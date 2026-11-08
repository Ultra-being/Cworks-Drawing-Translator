"""DWG in, DWG out, through the ODA File Converter.

Clients send DWG. ezdxf reads and writes DXF and nothing else, so a DWG is
turned into a DXF on the way in, translated like any other drawing, and
turned back into a DWG on the way out -- at the release it arrived as, so
what comes back opens the way what went in did.

The converter is a separate program, free from the Open Design Alliance,
installed in the Docker image. Nothing here fails on a machine without it:
`available()` says no and the app asks for a DXF instead, which is what it
asked for before any of this existed.

Set DXFT_ODAFC to the executable if it is not on the PATH -- an AppImage
unpacked under /opt, for instance.
"""
from __future__ import annotations

import os
import platform
import shutil
from pathlib import Path

import ezdxf
from ezdxf.addons import odafc
from ezdxf.lldxf.validator import dwg_version, is_dxf_file

# The release a DWG is read in as. ezdxf handles R2007 and later properly and
# 2018 is the newest the converter writes, so coming in at the newest keeps
# everything the drawing has. Going in at an old version would throw away the
# very things we are here to translate: MULTILEADER did not exist before 2008
# and ACAD_TABLE not before 2005, and a converter asked for R2000 turns both
# into something it can draw but nothing can read the words out of.
READ_AS = "ACAD2018"

# What to say when there is no converter. Staff see this on the upload form
# and in the error, so it has to name the way out, not the missing program.
NO_CONVERTER = ("DWG needs the ODA File Converter, which is not installed on this server. "
                "Open the drawing in AutoCAD, save as DXF (R2007 or later) and upload that.")


def _exec_path() -> str:
    return os.environ.get("DXFT_ODAFC", "").strip()


def available() -> bool:
    """True when a DWG can actually be converted here.

    Two things have to be true, and the second is easy to miss: the converter
    is a windowed program even when it is only converting a file, so on a
    server it needs a screen that is not there. ezdxf starts Xvfb to give it
    one; with neither Xvfb nor a display it reads os.environ["DISPLAY"] and
    raises KeyError, which tells staff nothing at all. Say no here instead.

    Not quite only a question: asking also hands DXFT_ODAFC to ezdxf, which
    is where it has to be registered before a conversion runs. That is why
    every conversion asks this first.
    """
    p = _exec_path()
    if p:
        if not Path(p).is_file():
            return False
        ezdxf.options.set("odafc-addon", "unix_exec_path", p)
    elif not odafc.is_installed():
        return False
    if platform.system() == "Linux" and not shutil.which("Xvfb") and not os.environ.get("DISPLAY"):
        return False
    return True


def release(path: str | Path) -> str | None:
    """Which AutoCAD release wrote this DWG, as a DXF version string.

    "AC1024" for 2010, and so on. None when the file does not say, which is
    reason enough to refuse it: it is not a DWG.
    """
    try:
        return dwg_version(str(path))
    except Exception:
        return None


def is_dwg(name: str) -> bool:
    return str(name).lower().endswith(".dwg")


def to_dxf(src: str | Path, dest: str | Path) -> None:
    """Convert a DWG to a DXF we can read.

    Audited on the way in, so a drawing with something broken in it is
    repaired by the converter rather than arriving half-read.
    """
    _convert(src, dest, READ_AS, audit=True)
    if not is_dxf_file(str(dest)):
        raise RuntimeError(f"the converter did not produce a DXF from {Path(src).name}")


def to_dwg(src: str | Path, dest: str | Path, version: str | None = None) -> None:
    """Convert our translated DXF back to a DWG, at `version` if it is known.

    Not audited. Audit repairs, and repairing is the one thing we do not want
    here: the DXF going in has already been verified against the original, and
    anything the converter decided to tidy up afterwards would be a change
    nobody measured.
    """
    v = odafc.map_version(version) if version else ""
    if v not in odafc.VALID_VERSIONS:
        v = READ_AS
    _convert(src, dest, v, audit=False)
    if release(dest) is None:
        raise RuntimeError(f"the converter did not produce a DWG from {Path(src).name}")


def _convert(src: str | Path, dest: str | Path, version: str, audit: bool) -> None:
    src, dest = Path(src), Path(dest)
    if not available():
        raise RuntimeError(NO_CONVERTER)
    if not src.is_file():
        raise FileNotFoundError(str(src))
    dest.parent.mkdir(parents=True, exist_ok=True)
    odafc.convert(str(src), str(dest), version=version, audit=audit, replace=True)
    # The converter is given a folder and told which file in it to take, and
    # whatever lands in the output folder is taken as the answer. Check that
    # what came back is the right kind of file before anybody downloads it:
    # an empty or wrong-format result has to be an error here, not a drawing
    # that will not open on somebody's desk a week later.
    if not dest.is_file() or dest.stat().st_size == 0:
        raise RuntimeError(f"the converter produced nothing from {src.name}")
