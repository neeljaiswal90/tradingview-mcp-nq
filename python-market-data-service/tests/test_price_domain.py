"""Regression checks for normalized trade prices and volume-profile price domain."""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from lob_features.microstructure import SessionVolumeProfile


def test_normalized_trade_prices_keep_vpoc_near_market_domain():
    """
    When trades arrive in display-price space, VPOC/VAL/VAH should stay in the
    same domain as the market mid rather than the raw Bookmap level-number domain.
    """
    vp = SessionVolumeProfile(tick_size=0.25)
    normalized_trades = [
        (25194.75, 8),
        (25195.00, 12),
        (25195.25, 25),
        (25195.25, 15),
        (25195.50, 10),
        (25196.00, 5),
    ]
    for price, size in normalized_trades:
        vp.add_trade(price, size)

    current_mid = 25195.25
    assert vp.vpoc == 25195.25
    assert abs(vp.vpoc - current_mid) <= 0.5

    val, vah = vp.value_area()
    assert val is not None and vah is not None
    assert val <= current_mid <= vah
    assert abs(vp.distance_to_vpoc(current_mid) or 0.0) <= 0.5
