import { Web3Provider } from '@ethersproject/providers' // ethers.js 提供的 Web3Provider 类型，用来把低级 transport 包装为 ethers Provider
import { useAccount } from 'hooks/useAccount' // 自定义钩子：获取当前钱包/账户信息（包含 chainId、address、isConnected 等）
import { useMemo } from 'react' // React 的 useMemo，用于 memoize 计算结果
import type { Chain, Client, Transport } from 'viem' // viem 的类型：Client、Transport、Chain
import { useClient, useConnectorClient } from 'wagmi' // wagmi 提供的钩子：获取全局 client 或连接器相关的 client

// 使用 WeakMap 缓存 viem Client -> ethers Web3Provider 的映射，
// 使用 WeakMap 可以在 Client 不再被引用时自动回收对应的 provider（避免内存泄漏）
const providers = new WeakMap<Client, Web3Provider>()

/**
 * clientToProvider
 * 将 viem 的 Client 转换为 ethers 的 Web3Provider（或返回 undefined）
 *
 * - client: viem Client（包含 chain 和 transport）
 * - chainId: 可选的链 id 备用值（当 client.chain 不可用时使用）
 *
 * 返回：Web3Provider | undefined
 */
export function clientToProvider(client?: Client<Transport, Chain>, chainId?: number) {
  if (!client) {
    return undefined
  }
  const { chain, transport } = client

  // 如果链上定义了 ENS registry 合约地址，将其传入 ethers provider 的 network 信息中
  const ensAddress = chain.contracts?.ensRegistry?.address
  // 构建 network 对象：优先使用 client.chain（包含更多信息），否则若提供 chainId 则返回一个简单的 Unsupported 名称的网络占位
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  const network = chain
    ? {
        chainId: chain.id,
        name: chain.name,
        ensAddress,
      }
    : chainId
      ? { chainId, name: 'Unsupported' }
      : undefined

  if (!network) {
    return undefined
  }

  // 如果已经缓存过对应的 provider，直接返回缓存（避免重复构造）
  if (providers.has(client)) {
    return providers.get(client)
  } else {
    // 否则基于 viem 的 transport 创建一个 ethers 的 Web3Provider 并缓存
    // 注意：ethers 的 Web3Provider 接受一个底层 provider/transport 对象以及 network 信息
    const provider = new Web3Provider(transport, network)
    providers.set(client, provider)
    return provider
  }
}

/**
 * useEthersProvider
 * 钩子：将 viem Client 转换为 ethers.js 的 Provider；
 * 提供 “已断开连接的 network 回退” 行为 —— 当账户连接到不同链时使用 disconnectedClient
 *
 * 参数：可选的 chainId（指定想要的链）
 *
 * 逻辑：
 * - useConnectorClient({ chainId }) 返回当前连接器（wallet）对应的 client（如果 wallet 已连接且链匹配）
 * - useClient({ chainId }) 返回 app 层的 client（通常是“断开/只读” client，用于展示或备用）
 * - 若当前钱包账户的 chainId 与传入 chainId 不一致（用户连接到了别的链），则优先使用 disconnectedClient（只读/回退）
 * - 最终将选中的 client 通过 clientToProvider 转换为 ethers Provider（并 memoize）
 */
export function useEthersProvider({ chainId }: { chainId?: number } = {}) {
  const account = useAccount()
  const { data: client } = useConnectorClient({ chainId }) // 连接器（钱包）对应的 client（可能 undefined）
  const disconnectedClient = useClient({ chainId }) // 全局 / 只读 client 作为回退

  return useMemo(
    () =>
      // 如果当前钱包连接的链（account.chainId）与目标 chainId 不一致，则使用断开/只读 client；
      // 否则优先使用 connector client（若为 undefined 则回退到 disconnectedClient）
      clientToProvider(account.chainId !== chainId ? disconnectedClient : client ?? disconnectedClient, chainId),
    [account.chainId, chainId, client, disconnectedClient],
  )
}

/**
 * useEthersWeb3Provider
 * 钩子：将已连接的 viem Connector Client（即 wallet 相关的 client）转换为 ethers 的 Provider
 * - 与 useEthersProvider 不同，此钩子不会考虑 account.chainId 与目标 chainId 的匹配（直接基于 connector client）
 */
export function useEthersWeb3Provider({ chainId }: { chainId?: number } = {}) {
  const { data: client } = useConnectorClient({ chainId })
  return useMemo(() => clientToProvider(client, chainId), [chainId, client])
}
