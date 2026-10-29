# compare-outbound

The outbound Worker of the `bidspoke-code-nodes-compare` dispatch namespace
(#1708). Shadow runs dispatch their code there, and it refuses every request a
script makes, so a shadow run sends nothing. It must refuse for ever, which is
why it is a separate Worker from `apps/ops-outbound`. It has its own deploy leg.

Shadow runs themselves are described in [docs/shadow-mode.md](../../docs/shadow-mode.md).
