"""The run so far, as a late or reloaded console receives it (gs/track.py)."""

from __future__ import annotations

from gs.track import HISTORY_INTERVAL_MS, HISTORY_MAX, TRACK_MAX, RunTrack

# ~1.1 m of latitude per 1e-5 deg
LAT0, LON0 = 37.4, -122.15


def frame(i: int, *, dlat: float = 0.0, connected: bool = True, **kw) -> dict:
    f = {"connected": connected, "upMs": i * 40, "lat": LAT0 + dlat, "lon": LON0, "alt": 120.0}
    f.update(kw)
    return f


def test_only_moves_of_two_metres_or_more_become_vertices():
    tr = RunTrack()
    for i in range(10):
        tr.add(frame(i, dlat=i * 1e-6))          # 0.11 m apart: one vertex
    tr.add(frame(11, dlat=3e-5))                 # 3.3 m on: a second
    assert len(tr.message()["track"]) == 2


def test_a_glitch_frame_far_away_is_dropped_not_joined():
    tr = RunTrack()
    tr.add(frame(0))
    tr.add(frame(1, dlat=0.1))                   # 11 km in 40 ms
    tr.add(frame(2, dlat=3e-5))
    lats = [p[0] for p in tr.message()["track"]]
    assert max(lats) < LAT0 + 1e-3 and len(lats) == 2


def test_no_fix_and_null_island_add_no_vertex():
    tr = RunTrack()
    tr.add(frame(0, lat=None))
    tr.add(frame(1, lat=0.0, lon=0.0))
    assert tr.message()["track"] == []


def test_a_stale_link_records_nothing():
    tr = RunTrack()
    tr.add(frame(0, connected=False))
    m = tr.message()
    assert m["track"] == [] and m["frames"] == []


def test_paths_and_history_are_bounded():
    tr = RunTrack()
    for i in range(TRACK_MAX + 50):
        tr.add(frame(i * 10, dlat=i * 3e-5, targetLat=LAT0 + i * 3e-5, targetLon=LON0))
    m = tr.message()
    assert len(m["track"]) == TRACK_MAX and len(m["target"]) == TRACK_MAX
    assert len(m["frames"]) == HISTORY_MAX
    # the newest survive
    assert m["track"][-1][0] == LAT0 + (TRACK_MAX + 49) * 3e-5


def test_history_keeps_one_frame_per_interval():
    tr = RunTrack()
    for i in range(100):                          # 4 s at 25 Hz
        tr.add(frame(i))
    ups = [f["upMs"] for f in tr.message()["frames"]]
    gaps = [b - a for a, b in zip(ups, ups[1:])]
    # the first frame at or past each interval: never closer, at most one frame later
    assert gaps and all(HISTORY_INTERVAL_MS <= g < HISTORY_INTERVAL_MS + 40 for g in gaps)


def test_the_target_path_rides_at_the_aircraft_altitude():
    tr = RunTrack()
    tr.add(frame(0, targetLat=LAT0 + 1e-3, targetLon=LON0, alt=88.0))
    assert tr.message()["target"] == [[LAT0 + 1e-3, LON0, 88.0]]


def test_clear_starts_a_new_run():
    tr = RunTrack()
    for i in range(20):
        tr.add(frame(i, dlat=i * 3e-5))
    tr.clear()
    m = tr.message()
    assert m == {"type": "history", "track": [], "target": [], "frames": []}
