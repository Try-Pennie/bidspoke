/**
 * The one way a minter goes through its TokenMemo (#2335, PR 4 of phase 5), so
 * no minter has to remember the rules on its own (L621):
 *
 *  - A CANDIDATE (verify or Reconnect, findings F116 and F126) is a credential
 *    bidding has not committed. It mints for its one call and never reads or
 *    fills the memo, so a token from an uncommitted credential is never handed
 *    to a committed call.
 *  - A RENEWAL after the service's expiry signal (Salesforce INVALID_SESSION_ID)
 *    evicts the memo entry only if it still holds the rejected Authorization,
 *    compared by identity (TokenMemo.evictIfHolds), then takes whatever the memo
 *    holds or mints. So concurrent rejections of one token cause one mint, and a
 *    token another caller has just minted is never thrown away.
 *  - A mint that ASKED A TOKEN ENDPOINT and was answered calls input.noteMint,
 *    so connectionFetch can end a refresh streak (Dan's decision 2). A signing
 *    that asks nobody (Snowflake's key pair JWT) does not.
 */
import type { Minted, TokenMemo, TokenMemoKey } from '../../../lib/token-memo'
import type { Authorization, AuthorizeInput } from '../service-rules'

export async function authorizeThroughMemo(
  memo: TokenMemo<Authorization>,
  key: TokenMemoKey,
  input: AuthorizeInput,
  mint: (nowMs: number) => Promise<Minted<Authorization>>,
  opts: { readonly asksTokenEndpoint: boolean; /** The clock the memo was given, for a candidate's mint (L524). */ readonly now: () => number },
): Promise<Authorization> {
  const counted = async (nowMs: number): Promise<Minted<Authorization>> => {
    const minted = await mint(nowMs)
    if (opts.asksTokenEndpoint) input.noteMint()
    return minted
  }
  if (input.candidate) return (await counted(opts.now())).value
  if (input.renew) memo.evictIfHolds(key, input.renew.rejected)
  return memo.get(key, counted)
}
