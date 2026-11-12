# One-Time Relay Wallet (Chrome Extension)

[中文](README.md) | English

When you withdraw from an exchange, this extension generates a brand-new, single-use EVM address for that withdrawal. Once the funds arrive, it automatically forwards them to your destination address B on the same chain.

The interface is available in English and Chinese. It follows your browser language by default, and the button at the top right switches between them.

## 2.1.0-beta: Tornado Cash mode

The mode switch appears only when the selected asset is native **ETH** and the chain has a supported Tornado Cash pool: Ethereum, Arbitrum or Optimism. Selecting another asset or chain turns the mode off and hides the switch. Enable it before generating an address. The destination and address-copying steps stay the same. A second fresh wallet receives this batch's Tornado withdrawals:

`Exchange → first wallet → Tornado Classic pools → second wallet → B`

The extension freezes the first eligible balance into a batch of fixed-denomination deposits (up to 100 notes). Unmixable change, unused fee reserves and later deposits initially stay in the first wallet. After completion, monitoring continues: once that wallet again covers at least 0.1 ETH of principal plus gas, another batch starts automatically. Closing the page pauses monitoring; reopening the session resumes it. Previous complete journals remain in the backup's `mixHistory`. Private keys can also be exported to recover residual funds manually. Every withdrawal must have 12 canonical block confirmations and its recipient, note nullifier and net receipt checked. Only after all withdrawals arrive does the second wallet forward the selected asset to B, less fees.

New mixing sessions use only ETH pools on the three chains above. ETH pools start at 0.1 ETH plus gas; other chains and assets use the ordinary forwarding mode. Healthy registered relayers are discovered automatically; an optional custom URL is available in Advanced. Unavailable relayers, excessive fees, incomplete RPC synchronization or insufficient gas pause processing without bypassing the pool. Initial historical synchronization can take time.

The progress view shows deposits, withdrawals, collection and forwarding. Notes and signed transactions are saved before broadcasting; reopening resumes the saved journal. Only one page can operate the wallet at a time. Export the full backup to retain both private keys and all notes. Proofs are generated locally; relayers receive only the proof and public transaction arguments. The website link is a reference entry point and receives no keys or notes. Timing, amount combinations and the final transfer can still provide correlation clues.

### Fee estimates

Ordinary transfers and Tornado network gas are shown separately in the chain's native coin and a reference USD value. Tornado service fees and the estimated total appear separately; the total remains pending until a relayer service-fee quote is known.

This version does not query relayer rates before funding. A relayer is selected while preparing a deposit, after Tornado is enabled and confirmed funds cover the principal and gas. Waiting or refreshing the estimate before funding updates network gas and coin prices only; it does not request a relayer quote.

Before funding, the default is one 0.1 ETH deposit. An optional expected mixing principal, in multiples of 0.1 ETH, previews the cost of multiple deposits without changing the actual transfer amount. An active session uses its actual batch plan. Budgets include margins and may differ from fees at execution. Tornado gas costs are very high: use caution for small amounts; this feature is not suitable for beginners.

Gas prices come from the selected RPC. USD uses native-coin reference prices from [CoinGecko](https://docs.coingecko.com/demo/reference/simple-price) or [DefiLlama](https://docs.llama.fi/list-your-project/how-to-request-token-pricing). Price requests contain coin identifiers, never wallet addresses, private keys or notes. If price services fail, native-coin estimates remain available with a dated cache or an unavailable USD label. Missing L2 data fees are marked incomplete. Estimates refresh periodically and can be refreshed manually.

### Build the beta

With Node.js 20 or later, run:

```sh
npm ci --ignore-scripts
npm run build
npm test
```

The build downloads pinned upstream circuit archives, verifies their Git blob SHA values, and generates the local prover, static worker and circuit files. The extension executes no remote JavaScript. Load `extension/` after building, or use a built release ZIP. Run `npm run test:browser` for the browser smoke checks. When updating, overwrite the files and reload the extension; do not uninstall it.

Sources: [pinned upstream UI/configuration](https://github.com/tornadocash/tornado-classic-ui/tree/a83fae0772c8da084c0e76b3a756b456f5b9f5bb), [Classic contracts](https://github.com/tornadocash/tornado-core).

## Install

To install this branch’s `2.1.0-beta`, build as described above and load `extension/`. `dist/relay-wallet-extension-v1.3.0.zip` is the historical v1.3.0 package.

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this repository's `extension/` directory (or the `extension` folder you get by unzipping the archive in `dist/`).
3. Click the extension icon in the toolbar to open the app page.

Do not delete or move that folder, and do not remove the extension from `chrome://extensions`: the private keys are kept in the extension's storage and are erased with it.

## Usage

Set up a passkey or password on first use; unlock when reopening the page.

1. Choose the chain and the asset you will receive (native coin / USDT / USDC / any token contract address), then enter destination address B.
2. Click **Generate one-time address**. Copy the address or scan the QR code, and withdraw from the exchange to it.
3. Ordinary mode forwards received funds to B. Tornado mode follows the two-wallet pool flow above and leaves the remainder in the first wallet. **Keep the page open until the forward has completed.**
4. Click **Reset / new address**, or reopen the extension, to enter a new B and get a fresh one-time address.

Supported chains: Ethereum, BNB Smart Chain, Polygon, Arbitrum, Optimism, Base, Avalanche, Linea, zkSync Era, Scroll, Mantle, Gnosis. You can set your own RPC under **Advanced**.

## Gas fees

- **Withdrawing the native coin (ETH/BNB/POL…)**: the fee is deducted from the amount received. No gas wallet is needed.
- **Withdrawing a token (USDT/USDC…)**: forwarding a token is paid with native coin on the one-time address. When the token arrives:
  - The one-time address has enough native coin: it forwards directly and the gas wallet is not used; leftover gas stays on the one-time address and is not sent to B.
  - Not enough, and a **Gas wallet** is bound: the gas wallet tops up the shortfall (30% above the estimate). After the token is sent to B, leftover gas is returned to the gas wallet.
  - Not enough, and no gas wallet is bound: the page shows the amount needed. Send a little native coin to the one-time address yourself, or bind a gas wallet on the spot; forwarding continues automatically once either is done. With a manual top-up, leftover gas also stays on the one-time address.
- **Leftover gas on a one-time address** is not moved automatically. To recover it, export the private key from the session view (restore the address under **Past addresses** first if needed), import it into any wallet and move the funds yourself.
- **The gas wallet is optional**: import a private key or generate a new wallet at the bottom of the page; it is saved once and reused afterwards. One gas wallet works on every EVM chain, but it needs a small native-coin balance on the chain you are using. If the balance is too low, the page tells you how much to deposit and continues automatically once it arrives.

Ordinary native transfers are estimated as one transaction. Token reference estimates include a gas top-up and token transfer, plus a refund when a gas wallet is bound. Existing gas can reduce the actual transaction count. Native-coin and USD display rules are described in “Fee estimates” above.

### Why Bitget Wallet gasless transfer is not supported

Integrating Bitget Wallet's gasless transfer (fee deducted from the USDT/USDC itself, no gas wallet needed) was considered and dropped.
Bitget Wallet's documentation does not state the minimum amount this method supports, so users could not be told in advance whether a given transfer would go through gasless.
To avoid misleading users, the option is not offered; token forwarding uses native gas from the relay address, topped up manually or by the optional gas wallet.

## Private key encryption

**A new install must set up private key encryption first**; the rest of the app becomes available once it is set. There are two unlock methods:

- **Passkey**: unlock with a passkey (fingerprint / face / PIN). The device or password manager holding the passkey must support the WebAuthn PRF extension; if it does not, the page says so and you should use a password instead.
- **Password**: at least 8 characters; works everywhere.
- Both can be set up, and either one unlocks. **Setting up both is recommended**: if every unlock method is lost (passkey deleted, device changed, password forgotten), the stored private keys cannot be recovered.

Once encrypted:

- The current session, past addresses and the gas wallet (private keys and addresses) are stored together under AES-256-GCM, with no plain-text copy.
- You unlock each time the page is opened or reloaded. Nothing is watched or forwarded while locked; it resumes after unlocking.
- **Show private key** (for the current session and the gas wallet) and Tornado **Export full backup** ask you to verify your passkey or password again every time.
- Adding an unlock method also requires verification with an existing method. Encryption cannot be turned off once it is on.
- Encryption protects the data at rest on disk. While the page is unlocked the keys are in memory, so it does not protect against malware that already controls your browser.

**Upgrading from 1.2.x, earlier versions or an unencrypted beta**: existing plain-text data is kept and the app keeps working, but the page shows that it is not encrypted yet, and private keys cannot be shown and full backups cannot be exported until encryption is turned on. Turning it on deletes the plain-text copies.

Both Tornado wallet keys, notes, transaction journals and previous `mixHistory` batches are encrypted together. Past-address balances also show the second wallet. Exported backups remain plain text and need safe storage.

## Security and limitations

- Private keys are generated randomly on your machine and stored only in the browser's extension storage. They are never uploaded, and are stored encrypted as described above.
- After a reset, old addresses stay under **Past addresses**. If funds arrive there later, click **Restore** to forward them; you can also export the private key from the session view.
- The **Past addresses** list shows each old address's native-coin balance (and the token balance for token sessions), marks non-zero ones with “has funds”, and has a Refresh button. Clearing the history permanently deletes those private keys, so any leftover gas on them becomes unrecoverable.
- On-chain transfers are public: anyone can follow "exchange → one-time address → B" in a block explorer.
  This tool only keeps B out of the exchange's withdrawal records. Ordinary mode does not provide mixer-level anonymity. Tornado mode does not guarantee unlinkability either, especially when a complete batch is collected and forwarded to B.
- The gas wallet's private key is encrypted together with the others; while the page is unlocked it can be used for automatic top-ups, so keep only a small amount of gas in it.
- The gas wallet has an on-chain transfer with every one-time address, so it can be used to link your one-time addresses together.
- Test with a small amount the first time you use it.
