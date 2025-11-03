import { getWagmiConnectorV2 } from '@binance/w3w-wagmi-connector-v2' // 从币安官方适配器获取 wagmi 连接器工厂
import { PLAYWRIGHT_CONNECT_ADDRESS } from 'components/Web3Provider/constants' // Playwright 测试用的 mock 帐号地址常量
import { WC_PARAMS } from 'components/Web3Provider/walletConnect' // WalletConnect 参数
import { embeddedWallet } from 'connection/EmbeddedWalletConnector' // 内置钱包连接器
import { UNISWAP_LOGO } from 'ui/src/assets' // Uniswap logo 资源（用于 coinbase appLogoUrl）
import { UNISWAP_WEB_URL } from 'uniswap/src/constants/urls' // Uniswap 官网 URL（用于拼接 logo 完整地址）
import { getChainInfo, ORDERED_EVM_CHAINS } from 'uniswap/src/features/chains/chainInfo' // 链信息与有序链列表
import { isTestnetChain } from 'uniswap/src/features/chains/utils' // 判断是否为测试网的工具函数
import { isPlaywrightEnv, isTestEnv } from 'utilities/src/environment/env' // 环境判断（Playwright / 测试环境）
import { logger } from 'utilities/src/logger/logger' // 项目统一 logger
import { getNonEmptyArrayOrThrow } from 'utilities/src/primitives/array' // 保证数组非空的辅助函数
import { Chain, createClient } from 'viem' // viem 的类型与客户端创建函数
import { Config, createConfig, fallback, http } from 'wagmi' // wagmi 配置和 transport 工具
import { coinbaseWallet, mock, safe, walletConnect } from 'wagmi/connectors' // wagmi 常用连接器

// 从 Binance 包里拿到具体的 wagmi 连接器实例（工厂调用）
const BinanceConnector = getWagmiConnectorV2()

/**
 * orderedTransportUrls
 * 根据传入的 chain（由 getChainInfo 返回）按优先级收集 RPC http URL 列表并去重
 *  返回值用于 wagmi transport 的 fallback 阵列（按优先级轮询）
 */
export const orderedTransportUrls = (chain: ReturnType<typeof getChainInfo>): string[] => {
  const orderedRpcUrls = [
    // 尝试从不同的 rpcUrls 字段按优先级读取 http URL（若某字段不存在则跳过）
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(chain.rpcUrls.interface?.http ?? []),
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    ...(chain.rpcUrls.default?.http ?? []),
    ...(chain.rpcUrls.public?.http ?? []),
    ...(chain.rpcUrls.fallback?.http ?? []),
  ]

  // 过滤空值并去重，返回最终按优先级排列的 URL 列表
  return Array.from(new Set(orderedRpcUrls.filter(Boolean)))
}

/**
 * createWagmiConnectors
 * 根据参数构建一组 wagmi 连接器（connectors）
 * params.includeMockConnector: 如果为 true，则将 wagmi 的 mock 连接器加入（主要用于 Playwright 测试）
 */
function createWagmiConnectors(params: {
  /** If `true`, appends the wagmi `mock` connector. Used in Playwright. */
  includeMockConnector: boolean
}): any[] {
  const { includeMockConnector } = params

  const baseConnectors = [
    // Binance 连接器（来自 @binance/w3w-wagmi-connector-v2）
    // showQrCodeModal: true 会在需要时显示二维码弹窗
    BinanceConnector({
      showQrCodeModal: true,
    }),

    // 在非 Playwright 的测试环境里，我们通常会排除 WalletConnect 以减少 log 噪声
    // i.e. 如果是 test env 且不是 Playwright，返回 []（不包含 walletConnect）
    ...(isTestEnv() && !isPlaywrightEnv() ? [] : [walletConnect(WC_PARAMS)]),

    // 内嵌钱包连接器（例如 app 内置钱包）
    embeddedWallet(),

    // Coinbase Wallet 连接器（提供 app 名称与 logo）
    coinbaseWallet({
      appName: 'Uniswap',
      // CB SDK 没有把父级 origin 传给 passkey 页面，因此这里暂时拼接完整的 Logo URL 作为 workaround
      // 已向 Coinbase 团队反馈，若他们修复可移除此处对 UNISWAP_WEB_URL 的依赖
      appLogoUrl: `${UNISWAP_WEB_URL}${UNISWAP_LOGO}`,
      // 断开连接时不要刷新页面（默认行为可能刷新）
      reloadOnDisconnect: false,
    }),

    // Gnosis Safe / Safe 钱包连接器
    safe(),
  ]

  // 如果需要 mock 连接器（Playwright 场景），则附加一个 mock 连接器（并指定 mock 帐户）
  return includeMockConnector
    ? [
        ...baseConnectors,
        mock({
          features: {},
          accounts: [PLAYWRIGHT_CONNECT_ADDRESS],
        }),
      ]
    : baseConnectors
}

/**
 * createWagmiConfig
 * 根据传入的 connector 列表和可选的 onFetchResponse 回调，创建 wagmi 的全局 config
 *
 * connectors: 要使用的 connector 列表
 * onFetchResponse: 自定义处理每次 http 请求响应的钩子，默认使用 defaultOnFetchResponse
 */
function createWagmiConfig(params: {
  /** The connector list to use. */
  connectors: any[]
  /** Optional custom `onFetchResponse` handler – defaults to `defaultOnFetchResponse`. */
  onFetchResponse?: (response: Response, chain: Chain, url: string) => void
}): Config<typeof ORDERED_EVM_CHAINS> {
  const { connectors, onFetchResponse = defaultOnFetchResponse } = params

  return createConfig({
    // 使用已经排序并且非空的 EVM 链列表
    chains: getNonEmptyArrayOrThrow(ORDERED_EVM_CHAINS),
    connectors,
    // 为每个链创建 viem client（通过 wagmi 的 client 回调）
    client({ chain }) {
      return createClient({
        chain,
        // 支持 batch multicall（提高 RPC 请求效率）
        batch: { multicall: true },
        // 轮询间隔（毫秒）
        pollingInterval: 12_000,
        // transport 使用 fallback（多个 URL 轮询，保证高可用）
        transport: fallback(
          orderedTransportUrls(chain).map((url) =>
            // 对每个 http transport 注入 onFetchResponse 回调以便监控 RPC 返回值
            http(url, { onFetchResponse: (response) => onFetchResponse(response, chain, url) }),
          ),
        ),
      })
    },
  })
}

// eslint-disable-next-line max-params
/**
 * defaultOnFetchResponse
 * 默认的 RPC 响应处理函数：当 HTTP status 非 200 时根据链类型做不同级别的日志记录
 * - 测试网（testnet）：仅记录 warn（因为测试网偶发性问题容忍度高）
 * - 主网（mainnet）：记录 error（需要及时修复）
 */
const defaultOnFetchResponse = (response: Response, chain: Chain, url: string) => {
  if (response.status !== 200) {
    const message = `RPC provider returned non-200 status: ${response.status}`

    // 仅在 testnet 链上发出 warn（避免主网报警泛滥）
    if (isTestnetChain(chain.id)) {
      logger.warn('wagmiConfig.ts', 'client', message, {
        extra: {
          chainId: chain.id,
          url,
        },
      })
    } else {
      // 对主网链记录为 error，附带堆栈信息与额外标签，便于排查和告警
      logger.error(new Error(message), {
        extra: {
          chainId: chain.id,
          url,
        },
        tags: {
          file: 'wagmiConfig.ts',
          function: 'client',
        },
      })
    }
  }
}

// 根据当前运行环境是否为 Playwright，决定是否包含 mock 连接器（Playwright 测试时需要）
const defaultConnectors = createWagmiConnectors({
  includeMockConnector: isPlaywrightEnv(),
})

// 导出全局 wagmiConfig，供应用其他部分使用
export const wagmiConfig = createWagmiConfig({ connectors: defaultConnectors })

// 为 wagmi 模块声明扩展类型（将 config 注册到 wagmi 的 Register 接口中）
// 这样在其它文件导入 wagmi 时能拿到正确类型的 config
declare module 'wagmi' {
  interface Register {
    // eslint-disable-next-line @typescript-eslint/consistent-type-imports
    config: typeof wagmiConfig
  }
}
