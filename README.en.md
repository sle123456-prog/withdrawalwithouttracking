# One-Time Relay Wallet (Chrome Extension)

[中文](README.md) | English

When you withdraw from an exchange, this extension generates a brand-new, single-use EVM address for that withdrawal. Once the funds arrive, it automatically forwards them to your destination address B on the same chain.

> The extension's interface is currently in Chinese only. The button and field names below are given in English with the on-screen Chinese label in parentheses.

## Install

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select this repository's `extension/` directory (or the `extension` folder you get by unzipping the archive in `dist/`).
3. Click the extension icon in the toolbar to open the app page.

Do not delete or move that folder, and do not remove the extension from `chrome://extensions`: the private keys are kept in the extension's storage and are erased with it.

## Usage

1. Choose the chain and the asset you will receive (native coin / USDT / USDC / any token contract address), then enter destination address B.
2. Click **Generate one-time address** (生成一次性地址). Copy the address or scan the QR code, and withdraw from the exchange to it.
3. When the funds arrive, everything is forwarded to B automatically. **Keep the page open until the forward has completed.**
4. Click **Reset / new address** (重置 / 新地址), or reopen the extension, to enter a new B and get a fresh one-time address.

Supported chains: Ethereum, BNB Smart Chain, Polygon, Arbitrum, Optimism, Base, Avalanche, Linea, zkSync Era, Scroll, Mantle, Gnosis. You can set your own RPC under **Advanced** (高级).

## Gas fees

- **Withdrawing the native coin (ETH/BNB/POL…)**: the fee is deducted from the amount received. No gas wallet is needed.
- **Withdrawing a token (USDT/USDC…)**: first configure a **Gas wallet** (Gas 钱包) at the bottom of the page, either by importing a private key or generating a new wallet. It is saved once and reused afterwards.
  When the token arrives, the gas wallet tops up the one-time address with the gas required (30% above the estimate). After the token is sent to B, leftover gas is returned to the gas wallet.
  One gas wallet works on every EVM chain, but it needs a small native-coin balance on the chain you are using. If the balance is too low, the page tells you how much to deposit and continues automatically once it arrives.

### Optional: Bitget Wallet gasless transfer (no gas wallet needed)

When receiving **USDT / USDC** on **Ethereum, BNB Chain, Base, Arbitrum or Polygon**, the setup form shows a **Use Bitget Wallet gasless transfer** checkbox (使用 Bitget Wallet 免 Gas 转账). With it ticked you do not need a gas wallet:

- The one-time address only signs offline; Bitget Wallet's relay submits the transaction, and **the fee is deducted from the USDT/USDC being transferred**. B receives the deposited amount minus the fee.
- This uses Bitget Wallet's public transfer API (`getTransferDataV4` + `send`). It is not the in-app "first transaction gas-free" promotion; no public interface was found that lets a third-party program claim that allowance.
- Whether a gasless plan is matched is decided by Bitget's server per chain, token and amount, and is not guaranteed. When unavailable, the extension retries every minute; if a gas wallet is configured it falls back to it, otherwise it asks you to top up gas manually.
- The extension verifies the RSA signature on Bitget's response before signing anything. The data to sign is still produced by Bitget's server, so you are trusting Bitget's relay. The exposure is limited to the funds on that one-time address.
- The transfer request goes through Bitget's servers, which can see the one-time address, address B and your IP.
- This mode has only been tested against a local mock of the API, not against Bitget's live service. Try a very small amount first.

## Security and limitations

- Private keys are generated randomly on your machine and stored only in the browser's extension storage (unencrypted). They are never uploaded.
- After a reset, old addresses stay under **History** (历史地址). If funds arrive there later, click **Restore** (恢复) to forward them; you can also export the private key from the session view.
- On-chain transfers are public: anyone can follow "exchange → one-time address → B" in a block explorer.
  This tool only keeps B out of the exchange's withdrawal records. It does not provide mixer-level anonymity.
- The gas wallet's private key is also stored unencrypted on your machine. Keep only a small amount of gas in it.
- The gas wallet has an on-chain transfer with every one-time address, so it can be used to link your one-time addresses together.
- Test with a small amount the first time you use it.
