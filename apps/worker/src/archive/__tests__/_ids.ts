/**
 * A realistic execution id for archive fixtures (#905).
 *
 * Every execution in production is a UUIDv7, measured on 2026-09-10 across the
 * whole retained window: 704,709 of 704,709, with exactly two code paths
 * minting one. The archive now REFUSES anything else, because the read path
 * derives the day it prunes on from the id.
 *
 * So a fixture using a made up id like `e1` was asserting about an execution the
 * system cannot produce, and every one of them started failing the moment the
 * refusal shipped, which is the refusal doing its job (L48).
 *
 * Defined once rather than in each suite: four files needed the same correction
 * and four copies of the reasoning is how one of them later drifts back.
 */
export const A_V7_EXECUTION_ID = '01a05cd7-2a00-7000-8000-000000000001'

/** A v4 id, for the suites that need to see the refusal fire. */
export const A_V4_EXECUTION_ID = 'a39376f1-0063-4b04-a1f7-0c0f42962ae6'
