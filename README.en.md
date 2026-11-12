# One-Time Relay Wallet (Chrome Extension)

[中文](README.md) | English

When you withdraw from an exchange, this extension generates a brand-new, single-use EVM address for that withdrawal. Once the funds arrive, it automatically forwards them to your destination address B on the same chain.

The interface is available in English and Chinese. It follows your browser language by default, and the button at the top right switches between them.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this repository's `extension/` directory (or the `extension` folder you get by unzipping the archive in `dist/`).
3. Click the extension icon in the toolbar to open the app page.

Do not delete or move that folder, and do not remove the extension from `chrome://extensions`: the private keys are kept in the extension's storage and are erased with it.

## Usage

1. Choose the chain and the asset you will receive (native coin / USDT / USDC / any token contract address), then enter destination address B.
2. Click **Generate one-time address**. Copy the address or scan the QR code, and withdraw from the exchange to it.
3. When the funds arrive, everything is forwarded to B automatically. **Keep the page open until the forward has completed.**
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

### Gas fee estimate

The setup view and the receiving view both show an **Estimated forwarding gas fee**, calculated from the selected chain's current gas price and shown as a native-coin amount plus its USD equivalent.

- Native coin: the cost of one plain transfer.
- Token: the gas top-up transfer (from the gas wallet or sent manually) plus the token transfer (estimated as a typical ERC-20 transfer).
- This is an estimate; the actual fee is set when the transaction is sent. The USD price comes from CoinGecko's public API; if it is unavailable, only the native-coin amount is shown.

### Why Bitget Wallet gasless transfer is not supported

Integrating Bitget Wallet's gasless transfer (fee deducted from the USDT/USDC itself, no gas wallet needed) was considered and dropped.
Bitget Wallet's documentation does not state the minimum amount this method supports, so users could not be told in advance whether a given transfer would go through gasless.
To avoid misleading users, the option is not offered; token forwarding always uses the gas wallet.

## Security and limitations

- Private keys are generated randomly on your machine and stored only in the browser's extension storage (unencrypted). They are never uploaded.
- After a reset, old addresses stay under **Past addresses**. If funds arrive there later, click **Restore** to forward them; you can also export the private key from the session view.
- The **Past addresses** list shows each old address's native-coin balance (and the token balance for token sessions), marks non-zero ones with “has funds”, and has a Refresh button. Clearing the history permanently deletes those private keys, so any leftover gas on them becomes unrecoverable.
- On-chain transfers are public: anyone can follow "exchange → one-time address → B" in a block explorer.
  This tool only keeps B out of the exchange's withdrawal records. It does not provide mixer-level anonymity.
- The gas wallet's private key is also stored unencrypted on your machine. Keep only a small amount of gas in it.
- The gas wallet has an on-chain transfer with every one-time address, so it can be used to link your one-time addresses together.
- Test with a small amount the first time you use it.
