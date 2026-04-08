package com.nqtrader.bookmap;

/**
 * Lightweight smoke test for the addon price normalizer.
 *
 * No JUnit dependency on purpose: compile and run this class directly with the
 * same Bookmap jars used for the addon build.
 */
public class BboForwarderNormalizationSmokeTest {
    public static void main(String[] args) {
        assertClose(
            "trade price in level-number domain should scale by pips",
            25195.0,
            BboForwarder.normalizeTradePriceForWire(100780.0, 0.25, 25195.0)
        );
        assertClose(
            "already-normalized trade price should stay unchanged when reference agrees",
            25195.0,
            BboForwarder.normalizeTradePriceForWire(25195.0, 0.25, 25195.0)
        );
        assertClose(
            "fallback should still scale trade price when no reference exists",
            25195.0,
            BboForwarder.normalizeTradePriceForWire(100780.0, 0.25, null)
        );
        assertClose(
            "level-number depth/BBO prices should scale via pips",
            25195.0,
            BboForwarder.normalizeLevelPrice(100780, 0.25)
        );
        assertEquals(
            "price scale source should reflect normalization path",
            "raw_times_pips",
            BboForwarder.tradePriceScaleSource(100780.0, 25195.0)
        );
        assertEquals(
            "price scale source should preserve already-correct prices",
            "raw",
            BboForwarder.tradePriceScaleSource(25195.0, 25195.0)
        );
        System.out.println("BboForwarderNormalizationSmokeTest PASS");
    }

    private static void assertClose(String label, double expected, double actual) {
        if (Math.abs(expected - actual) > 1e-9) {
            throw new AssertionError(label + " expected=" + expected + " actual=" + actual);
        }
    }

    private static void assertEquals(String label, String expected, String actual) {
        if (!expected.equals(actual)) {
            throw new AssertionError(label + " expected=" + expected + " actual=" + actual);
        }
    }
}
