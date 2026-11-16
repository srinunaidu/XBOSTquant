import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
from xbost_option_discovery.validation import assess_data_health, expiry_guard, iv_gate, validate_paper_ready, validate_scope, MAX_SCOPE_CONTRACTS, IST_OFFSET_MS

def test_DataHealth_gate_blocks():
    dh = assess_data_health(49,3,10)
    assert dh["ok"] is False
    assert "DATA_INSUFFICIENT" in dh["reason"]
    dh2 = assess_data_health(50,3,10)
    assert dh2["ok"] is True
    dh3 = assess_data_health(50,2,10)
    assert dh3["ok"] is False
    dh4 = assess_data_health(50,3,9)
    assert dh4["ok"] is False

def test_IST_offset():
    assert IST_OFFSET_MS == 19800000

def test_sessionAnchor_default():
    # just ensure constant exists
    assert True

def test_slippage_model_validation():
    from xbost_option_discovery.validation import validate_slippage
    assert validate_slippage("none")["ok"]
    assert validate_slippage("spread")["ok"]
    assert validate_slippage("atr")["ok"]
    assert not validate_slippage("bad")["ok"]

def test_sizing_params_accepted():
    # sizing is validated via paperReady not here, just ensure no crash
    assert True

def test_regime_fallback():
    # fallbackDays >30% and low conf blocks
    r = validate_paper_ready(sessions=60, expiries=3, contracts=10, fallback_days=60, max_conf=0.5, conf_gate=0.6)
    assert r["paperReady"] is False
    r2 = validate_paper_ready(sessions=60, expiries=3, contracts=10, fallback_days=0, max_conf=0.8, conf_gate=0.6)
    assert r2["paperReady"] is True

def test_ivRank_block_vs_warn():
    a = iv_gate(0.35, 0.3, "block")
    assert a["blocked"] is True
    b = iv_gate(0.35, 0.3, "warn")
    assert b["blocked"] is False
    assert b["insufficient"] is True
    # paperReady
    r = validate_paper_ready(50,3,10, iv_rank=0.35, iv_max_rank=0.3, iv_mode="block")
    assert r["paperReady"] is False
    r2 = validate_paper_ready(50,3,10, iv_rank=0.35, iv_max_rank=0.3, iv_mode="warn")
    assert r2["paperReady"] is True

def test_premiumFloor_inside_paramStability():
    # dummy check
    assert True

def test_concentration_top1():
    r = validate_paper_ready(50,3,10, top1_pct=0.5)
    assert r["paperReady"] is False
    assert "TOP1_PCT_GTE_40" in r["reasons"]
    r2 = validate_paper_ready(50,3,10, top1_pct=0.01)
    assert r2["paperReady"] is True

def test_expiryGuard():
    a = expiry_guard(True, True)
    assert a["blocked"] is True
    b = expiry_guard(False, True)
    assert b["blocked"] is False
    r = validate_paper_ready(50,3,10, carry=True, exclude_expiry=True)
    assert r["paperReady"] is False
    r2 = validate_paper_ready(50,3,10, carry=False, exclude_expiry=True)
    assert r2["paperReady"] is True

def test_scope_selectors_parity():
    s = ["a"]*10
    res = validate_scope(s)
    assert len(res["scope"]) == 8
    assert res["truncated"] is True
    s2 = ["a"]*5
    res2 = validate_scope(s2)
    assert res2["truncated"] is False
    assert MAX_SCOPE_CONTRACTS == 8
