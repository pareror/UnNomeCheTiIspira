from acoustic_models.decision import LED_AMBER, LED_GREEN, LED_RED, DecisionLogic


def test_hysteresis_and_led_states():
    logic = DecisionLogic()

    assert logic.update(0.0, 0.0)["led"] == LED_GREEN

    result = None
    for _ in range(3):
        result = logic.update(0.9, 0.0)
    assert result["alarm"] is True
    assert result["led"] == LED_AMBER

    assert logic.update(0.9, 0.95)["led"] == LED_RED

    for _ in range(3):
        result = logic.update(0.0, 0.0)
    assert result["alarm"] is False
    assert result["led"] == LED_GREEN


def test_smoothing_averages_window():
    logic = DecisionLogic()
    assert logic.smooth(0.0) == 0.0
    assert logic.smooth(0.0) == 0.0
    assert abs(logic.smooth(0.9) - 0.3) < 1e-9
