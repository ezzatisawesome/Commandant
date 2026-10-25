"""Surfaces are decoded on the vehicle's OWN output map, not fixed positions.

gs used to read ACTUATOR_OUTPUT_STATUS indices 5/6/7 as left/right aileron and
elevator: rev6's SITL wiring. On rev7 and on a HITL Pixhawk those indices are
other outputs, and the console showed the aileron pinned near -50 % (half of an
unmapped output at -100 %) while the aircraft banked 40 deg each way. The map
now comes from the vehicle's params: which channel carries which servo function
(HIL_ACT_FUNC / PWM_MAIN_FUNC), and which surface each servo is
(CA_SV_CS<k>_TYPE). HITL decodes HIL_ACTUATOR_CONTROLS, the simulated commands.
"""
from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))
sys.path.insert(0, os.path.dirname(__file__))

from gs.bridge import surface_channels, surfaces_pct      # noqa: E402
from test_flight_ready import _bridge                     # noqa: E402

# rev7 as a HITL board reports it: simulated surfaces on HIL_ACT 6-9, the real
# servos on MAIN 3-6, the ESC's MAIN1 unmapped; servos 1-4 = L/R aileron,
# elevator, rudder.
REV7 = {"HIL_ACT_FUNC5": 101, "HIL_ACT_FUNC6": 201, "HIL_ACT_FUNC7": 202,
        "HIL_ACT_FUNC8": 203, "HIL_ACT_FUNC9": 204,
        "PWM_MAIN_FUNC1": 0, "PWM_MAIN_FUNC3": 201, "PWM_MAIN_FUNC4": 202,
        "PWM_MAIN_FUNC5": 203, "PWM_MAIN_FUNC6": 204,
        "CA_SV_CS0_TYPE": 1, "CA_SV_CS1_TYPE": 2, "CA_SV_CS2_TYPE": 3,
        "CA_SV_CS3_TYPE": 4}


class _Msg:
    def __init__(self, kind, **kw):
        self._kind = kind
        self.__dict__.update(kw)

    def get_type(self):
        return self._kind


def test_the_map_comes_from_the_params():
    assert surface_channels(REV7, "HIL_ACT_FUNC") == {
        "left_aileron": [6], "right_aileron": [7], "elevator": [8], "rudder": [9]}
    assert surface_channels(REV7, "PWM_MAIN_FUNC") == {
        "left_aileron": [3], "right_aileron": [4], "elevator": [5], "rudder": [6]}
    assert surface_channels({}, "PWM_MAIN_FUNC") == {}   # unknown stays unknown


def test_a_missing_surface_is_none_not_zero():
    twin_fins = {k: v for k, v in REV7.items() if k != "PWM_MAIN_FUNC6"}
    s = surfaces_pct(surface_channels(twin_fins, "PWM_MAIN_FUNC"), lambda n: 0.0)
    assert s["rudder"] is None and s["elevator"] == 0.0


def test_hitl_decodes_the_simulated_commands_not_the_real_outputs():
    b = _bridge()
    b._outmap.update(REV7)
    # right bank: left aileron -0.6, right +0.6; elevator 0.3; rudder -0.2
    controls = [0.0] * 16
    controls[5], controls[6], controls[7], controls[8] = -0.6, 0.6, 0.3, -0.2
    b._on_mav_state(10_000, "HIL_ACTUATOR_CONTROLS",
                    _Msg("HIL_ACTUATOR_CONTROLS", controls=controls))
    L = b.latest
    assert abs(L["aileron"] - 60.0) < 1e-9 and abs(L["elevator"] - 30.0) < 1e-9
    assert abs(L["rudder"] + 20.0) < 1e-9
    # the board's PWM report right after (its real outputs, all centred) is ignored
    b._on_mav_state(10_100, "ACTUATOR_OUTPUT_STATUS",
                    _Msg("ACTUATOR_OUTPUT_STATUS", actuator=[0, 0, 1500, 1500, 1500, 1500,
                                                              0, 0] + [0] * 8))
    assert abs(L["aileron"] - 60.0) < 1e-9


def test_without_hil_controls_the_pwm_bank_is_decoded_on_its_own_map():
    b = _bridge()
    b._outmap.update(REV7)
    pwm = [0] * 16
    pwm[2], pwm[3], pwm[4], pwm[5] = 1250, 1750, 1600, 1500     # MAIN3..6
    b._on_mav_state(10_000, "ACTUATOR_OUTPUT_STATUS",
                    _Msg("ACTUATOR_OUTPUT_STATUS", actuator=pwm))
    L = b.latest
    assert abs(L["aileron"] - 50.0) < 1e-9          # (right 50 - left -50) / 2
    assert abs(L["elevator"] - 20.0) < 1e-9 and abs(L["rudder"]) < 1e-9


def test_a_reboot_forgets_the_map():
    b = _bridge()
    b._outmap.update(REV7)
    b._forget_output_map()
    assert b._outmap == {} and b._outmap_tries == 0
