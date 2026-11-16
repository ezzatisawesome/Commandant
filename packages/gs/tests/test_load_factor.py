"""The load factor, from PX4's IMU, for the wing-load readout.

HIGHRES_IMU's body-z specific force IS the load factor (level flight reads
zacc = -g). PX4's GCS stream does not carry it, so gs requests it like WIND_COV
(at most LOAD_FACTOR_HZ) and smooths it (LOAD_FACTOR_ALPHA)."""
from __future__ import annotations

from test_flight_ready import RecordingConn, _bridge, _heartbeat, _msg
from test_statustext_chunks import _TrimConn

from gs.bridge import (
    _IMU_ZACC,
    _TRIMMABLE,
    LOAD_FACTOR_ALPHA,
    LOAD_FACTOR_HZ,
    MSG_HIGHRES_IMU,
)

G = 9.80665


def _imu(zacc, updated=_IMU_ZACC):
    return _msg("HIGHRES_IMU", time_usec=0, zacc=zacc, fields_updated=updated)


def _fed(*zaccs, updated=_IMU_ZACC):
    b = _bridge()
    conn = RecordingConn()
    b._on_mav(conn, _heartbeat())
    for z in zaccs:
        b._on_mav(conn, _imu(z, updated))
    return b


def test_level_flight_reads_one_g():
    assert abs(_fed(-G).latest["loadFactor"] - 1.0) < 1e-9


def test_a_pull_up_is_smoothed_toward_its_load_not_jumped_to():
    b = _fed(-G, -2 * G)
    assert abs(b.latest["loadFactor"] - (1 + LOAD_FACTOR_ALPHA)) < 1e-9
    for _ in range(40):
        b._on_mav(RecordingConn(), _imu(-2 * G))
    assert abs(b.latest["loadFactor"] - 2.0) < 1e-3


def test_a_sample_without_a_valid_z_is_ignored():
    assert "loadFactor" not in _fed(-G, updated=0).latest


def test_the_imu_is_requested_at_10_hz_and_never_trimmed():
    assert "HIGHRES_IMU" not in _TRIMMABLE
    b = _bridge()
    conn = _TrimConn()
    b._request_message(conn, 1, 1, MSG_HIGHRES_IMU, hz_max=LOAD_FACTOR_HZ)
    cmd, msg_id, interval = conn.sent[0]
    assert (cmd, msg_id) == (511, MSG_HIGHRES_IMU)
    assert interval >= int(1e6 / LOAD_FACTOR_HZ), "asked for more than LOAD_FACTOR_HZ"
