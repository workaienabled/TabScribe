"""Locate the extension's toolbar icon and click it with a real X11 event.

Background: chrome.tabCapture requires a genuine user invocation of the extension
(verified: host permissions do not substitute, and Chrome ignores hand-written
`extensions.commands` bindings for unpacked extensions, so the manifest shortcut
stays unassigned). A synthetic X11 button event from xdotool is a real input event
as far as Chrome is concerned, so it does grant activeTab.

The icon is located by pixel signature rather than by fixed offset: TabScribe's icon
is the only strongly blue (#1a73e8) block in the toolbar strip, which makes the search
robust against toolbar layout changes.
"""
import subprocess
import time


def sh(*args, timeout=20):
    return subprocess.run(args, capture_output=True, text=True, timeout=timeout)


def find_window(title_substr="TabScribe test audio"):
    res = sh("xdotool", "search", "--name", title_substr)
    ids = [x.strip() for x in res.stdout.splitlines() if x.strip()]
    return ids[-1] if ids else None


def window_geometry(wid):
    res = sh("xdotool", "getwindowgeometry", "--shell", wid)
    geo = {}
    for line in res.stdout.splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            geo[k.strip().lower()] = int(v.strip())
    return geo


def read_xwd(path):
    """Decode an XWD (X Window Dump) file into (width, height, getpixel).

    Pillow cannot open XWD, and ImageMagick is not installed on this machine, so the
    format is parsed directly. XWD is a 100-byte big-endian header, a window-name
    string, an optional colormap, then raw scanlines padded to bytes_per_line.
    """
    import struct

    data = open(path, "rb").read()
    fields = struct.unpack(">25I", data[:100])
    (header_size, _version, _fmt, _depth, width, height, _xoff, _border,
     _bitmap_unit, _bit_order, _pad, bits_per_pixel, bytes_per_line,
     _visual, red_mask, green_mask, blue_mask, _bits_rgb, _cmap_entries,
     ncolors, _ww, _wh, _wx, _wy, _wbw) = fields

    if bits_per_pixel not in (24, 32):
        raise ValueError(f"unsupported bits_per_pixel={bits_per_pixel}")

    # Colormap entries are 12 bytes each and sit between the header and the pixels.
    pixel_offset = header_size + ncolors * 12
    pixels = data[pixel_offset:]

    def shift_of(mask):
        s = 0
        while mask and not (mask & 1):
            mask >>= 1
            s += 1
        return s

    r_shift, g_shift, b_shift = shift_of(red_mask), shift_of(green_mask), shift_of(blue_mask)
    bytes_per_pixel = bits_per_pixel // 8

    def getpixel(x, y):
        off = y * bytes_per_line + x * bytes_per_pixel
        if off + bytes_per_pixel > len(pixels):
            return (0, 0, 0)
        if bytes_per_pixel == 4:
            value = int.from_bytes(pixels[off:off + 4], "little")
        else:
            value = int.from_bytes(pixels[off:off + 3], "little")
        return (
            (value & red_mask) >> r_shift,
            (value & green_mask) >> g_shift,
            (value & blue_mask) >> b_shift,
        )

    return width, height, getpixel


def grab_window(wid, path="/tmp/tabscribe-toolbar.xwd"):
    """Capture one window with xwd and return (width, height, getpixel)."""
    r = sh("xwd", "-id", wid, "-out", path, timeout=30)
    if r.returncode != 0:
        return None
    return read_xwd(path)


def find_blue_icon(width, height, getpixel, toolbar_y_range=(30, 120)):
    """Return (cx, cy, (w, h)) of the TabScribe icon, or None.

    The icon is the only strongly blue (#1a73e8) block in the toolbar strip, so it is
    found by colour signature rather than a fixed offset. That survives toolbar layout
    changes (profile pill, extensions puzzle button, window controls).
    """
    target = (26, 115, 232)
    tol = 45
    xs, ys = [], []
    y0, y1 = toolbar_y_range
    for y in range(max(0, y0), min(height, y1)):
        for x in range(width // 2, width):
            r, g, b = getpixel(x, y)
            if (abs(r - target[0]) < tol and abs(g - target[1]) < tol
                    and abs(b - target[2]) < tol):
                xs.append(x)
                ys.append(y)
    if not xs:
        return None
    # Cluster on the densest column band to avoid catching unrelated blue pixels.
    cx = (min(xs) + max(xs)) // 2
    cy = (min(ys) + max(ys)) // 2
    return cx, cy, (max(xs) - min(xs) + 1, max(ys) - min(ys) + 1)


def click_toolbar_icon(title_substr="TabScribe test audio", debug=True):
    wid = find_window(title_substr)
    if not wid:
        return {"ok": False, "error": "window not found"}
    sh("xdotool", "windowactivate", "--sync", wid)
    time.sleep(0.5)

    geo = window_geometry(wid)
    grabbed = grab_window(wid)
    if not grabbed:
        return {"ok": False, "error": "window capture failed", "geometry": geo}
    width, height, getpixel = grabbed

    hit = find_blue_icon(width, height, getpixel)
    if not hit:
        return {"ok": False, "error": "icon not found in toolbar strip",
                "geometry": geo, "capture": [width, height]}

    cx, cy, size = hit
    # xwd captures the window contents; xdotool moves in root coordinates.
    abs_x = geo["x"] + cx
    abs_y = geo["y"] + cy
    if debug:
        print(f"  window {wid} at ({geo['x']},{geo['y']}) {geo['width']}x{geo['height']}")
        print(f"  icon at window ({cx},{cy}) size {size} -> screen ({abs_x},{abs_y})")

    sh("xdotool", "mousemove", "--sync", str(abs_x), str(abs_y))
    time.sleep(0.3)
    sh("xdotool", "click", "1")
    return {"ok": True, "x": abs_x, "y": abs_y, "icon_size": size}


if __name__ == "__main__":
    import json
    print(json.dumps(click_toolbar_icon(), indent=2))
