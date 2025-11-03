import { BigNumber } from '@ethersproject/bignumber' // 处理大整数的库（用于金额等）
import type { Percent } from '@uniswap/sdk-core' // Uniswap SDK 的百分比类型（滑点等）
import { TradeType } from '@uniswap/sdk-core' // 交易类型枚举：EXACT_INPUT / EXACT_OUTPUT
import type { FlatFeeOptions } from '@uniswap/universal-router-sdk' // universal router 的平费选项类型
import type { FeeOptions } from '@uniswap/v3-sdk' // v3 SDK 的费用选项类型
import { useAccount } from 'hooks/useAccount' // 钩子：获取当前钱包/账户信息
import type { PermitSignature } from 'hooks/usePermitAllowance' // permit 签名类型（可选授权）
import useSelectChain from 'hooks/useSelectChain' // 钩子：切换/选择链（提示用户切换 wallet 链）
import { useUniswapXSwapCallback } from 'hooks/useUniswapXSwapCallback' // 钩子：UniswapX 专用的 swap 回调
import { useUniversalRouterSwapCallback } from 'hooks/useUniversalRouter' // 钩子：universal router 的 swap 回调
import { useCallback } from 'react' // React 的 useCallback
import { useMultichainContext } from 'state/multichain/useMultichainContext' // 多链上下文（当前 swap 的目标链 id）
import type { InterfaceTrade } from 'state/routing/types' // 内部路由系统的 trade 接口类型
import { OffchainOrderType, TradeFillType } from 'state/routing/types' // 订单/填充类型枚举
import { isClassicTrade, isUniswapXTrade } from 'state/routing/utils' // 判断 trade 类型的工具函数
import { useAddOrder } from 'state/signatures/hooks' // 钩子：将 uniswapX 订单加入到签名/订单状态里
import type { UniswapXOrderDetails } from 'state/signatures/types' // UniswapX 订单详情类型
import { useTransaction, useTransactionAdder } from 'state/transactions/hooks' // 交易状态相关钩子
import type { TransactionInfo } from 'state/transactions/types' // 交易信息类型
import { useSupportedChainId } from 'uniswap/src/features/chains/hooks/useSupportedChainId' // 钩子：将 wallet 的 chainId 转换为支持的 chainId
import { UniverseChainId } from 'uniswap/src/features/chains/types' // Universe 链 id 类型
import { isEVMChain } from 'uniswap/src/features/platforms/utils/chains' // 判断链是否为 EVM 链
import { TransactionStatus, TransactionType } from 'uniswap/src/features/transactions/types/transactionDetails' // 交易状态与类型枚举
import { currencyId } from 'uniswap/src/utils/currencyId' // 生成 currency 唯一 id 的工具

// 导出 useSwapCallback 的返回类型别名：解析返回的 Promise 结果类型
export type SwapResult = Awaited<ReturnType<ReturnType<typeof useSwapCallback>>>

type UniversalRouterFeeField = { feeOptions: FeeOptions } | { flatFeeOptions: FlatFeeOptions }
// universal router 可能使用两种费用字段之一：按百分比的 feeOptions 或 固定金额的 flatFeeOptions

/**
 * getUniversalRouterFeeFields
 * - 针对 classic trade（非 UniswapX），如果 trade 带有 swapFee，则构造对应的 router fee 字段
 * - 对于 EXACT_INPUT：使用 feeOptions（百分比）并指定接收者
 * - 对于 EXACT_OUTPUT：使用 flatFeeOptions（固定金额，以 BigNumber 表示）并指定接收者
 * - 若非 classic trade 或不含 swapFee，则返回 undefined
 */
function getUniversalRouterFeeFields(trade?: InterfaceTrade): UniversalRouterFeeField | undefined {
  if (!isClassicTrade(trade)) {
    return undefined
  }
  if (!trade.swapFee) {
    return undefined
  }

  if (trade.tradeType === TradeType.EXACT_INPUT) {
    // 精确输入：费用以百分比表示
    return { feeOptions: { fee: trade.swapFee.percent, recipient: trade.swapFee.recipient } }
  } else {
    // 精确输出：费用以固定金额表示（需要 BigNumber）
    return { flatFeeOptions: { amount: BigNumber.from(trade.swapFee.amount), recipient: trade.swapFee.recipient } }
  }
}

// 返回一个会执行 swap 的函数（当所有前置参数/环境满足时）
// 并且会将交易/订单信息写入本地状态（交易记录 / offchain 订单）
export function useSwapCallback({
  trade,
  fiatValues,
  allowedSlippage,
  permitSignature,
}: {
  trade?: InterfaceTrade // 要执行的交易对象（可能为 undefined）
  fiatValues: { amountIn?: number; amountOut?: number; feeUsd?: number } // 用于分析/埋点的法币估值（输入/输出/费用）
  allowedSlippage: Percent // 允许滑点（以 Percent 表示）
  permitSignature?: PermitSignature // 可选的 permit 签名（用于免 approve 场景）
}) {
  const addTransaction = useTransactionAdder() // 将交易添加到本地状态/队列的函数
  const addOrder = useAddOrder() // 将 offchain 订单添加到本地状态的函数（用于 UniswapX）
  const account = useAccount() // 当前钱包/账户信息（包含 isConnected, address, chainId 等）
  const supportedConnectedChainId = useSupportedChainId(account.chainId) // 将 wallet 返回的 chainId 映射为支持的 chain id（或 undefined）
  const { chainId: swapChainId } = useMultichainContext() // 从多链上下文读取当前 swap 目标链 id

  // 为 UniswapX trade 构建 swap 回调（如果 trade 是 UniswapX 类型则传入，否则 undefined）
  const uniswapXSwapCallback = useUniswapXSwapCallback({
    trade: isUniswapXTrade(trade) ? trade : undefined,
    allowedSlippage,
    fiatValues,
  })

  // 为 classic/universal router trade 构建 swap 回调（如果 trade 是 classic 类型则传入，否则 undefined）
  const universalRouterSwapCallback = useUniversalRouterSwapCallback({
    trade: isClassicTrade(trade) ? trade : undefined,
    fiatValues,
    options: {
      slippageTolerance: allowedSlippage,
      permit: permitSignature,
      ...getUniversalRouterFeeFields(trade), // 根据 trade 是否带 swapFee 注入 fee 字段
    },
  })

  const selectChain = useSelectChain() // 钩子：提示钱包切换到指定链，并返回结果
  // 根据 trade 类型选择具体的 swap 回调实现（UniswapX 或 universal router）
  const swapCallback = isUniswapXTrade(trade) ? uniswapXSwapCallback : universalRouterSwapCallback

  // useCallback 返回一个 memoized 的异步函数，执行 swap 并记录结果
  return useCallback(async () => {
    // 参数/环境检查：必须有 trade
    if (!trade) {
      throw new Error('missing trade')
    } else if (!account.isConnected || !account.address) {
      // 钱包必须连接并且有地址
      throw new Error('wallet must be connected to swap')
    } else if (!swapChainId) {
      // 必须知道要在哪条链上执行 swap
      throw new Error('missing swap chainId')
    } else if (!isEVMChain(swapChainId)) {
      // 目前 legacy limits 流程只支持 EVM 链
      throw new Error('non EVM chain in legacy limits flow')
    } else if (!supportedConnectedChainId || supportedConnectedChainId !== swapChainId) {
      // 如果当前 wallet 的链与目标链不一致，则尝试让用户切换链
      const correctChain = await selectChain(swapChainId)
      if (!correctChain) {
        throw new Error('wallet must be connected to correct chain to swap')
      }
    }

    // 调用实际的 swap 回调（会返回不同类型的结果，取决于填充方式）
    const result = await swapCallback()

    // 构造通用的 TransactionInfo（用于记录/展示）
    const swapInfo: TransactionInfo = {
      type: TransactionType.Swap,
      inputCurrencyId: currencyId(trade.inputAmount.currency), // 输入代币的唯一 id
      outputCurrencyId: currencyId(trade.outputAmount.currency), // 输出代币的唯一 id
      // 标记是否为 UniswapX 订单（用于区分 offchain 订单流程）
      isUniswapXOrder: result.type === TradeFillType.UniswapX || result.type === TradeFillType.UniswapXv2,
      // 根据 tradeType 填充不同字段（EXACT_INPUT / EXACT_OUTPUT）
      ...(trade.tradeType === TradeType.EXACT_INPUT
        ? {
            tradeType: TradeType.EXACT_INPUT,
            inputCurrencyAmountRaw: trade.inputAmount.quotient.toString(), // 原始输入金额（整数字符串）
            expectedOutputCurrencyAmountRaw: trade.outputAmount.quotient.toString(), // 期望输出金额
            minimumOutputCurrencyAmountRaw: trade.minimumAmountOut(allowedSlippage).quotient.toString(), // 按滑点计算的最小输出
          }
        : {
            tradeType: TradeType.EXACT_OUTPUT,
            maximumInputCurrencyAmountRaw: trade.maximumAmountIn(allowedSlippage).quotient.toString(), // 按滑点计算的最大输入
            outputCurrencyAmountRaw: trade.outputAmount.quotient.toString(), // 输出金额（精确）
            expectedInputCurrencyAmountRaw: trade.inputAmount.quotient.toString(), // 期望输入金额
          }),
    }

    // 根据 swap 回调返回的填充类型决定后续处理
    switch (result.type) {
      case TradeFillType.UniswapX:
      case TradeFillType.UniswapXv2:
        // 如果是 UniswapX 的 offchain 订单，则将订单信息写入订单状态（addOrder）
        addOrder({
          offerer: account.address,
          orderHash: result.response.orderHash,
          chainId: supportedConnectedChainId as UniverseChainId, // 类型断言：已在上面确保一致
          expiry: result.response.deadline,
          swapInfo: swapInfo as UniswapXOrderDetails['swapInfo'], // 满足类型期望
          encodedOrder: result.response.encodedOrder,
          // offchainOrderType：如果 trade 本身是 UniswapX，则使用其 offchainOrderType，否则默认为 DUTCH_AUCTION（类型安全）
          offchainOrderType: isUniswapXTrade(trade) ? trade.offchainOrderType : OffchainOrderType.DUTCH_AUCTION,
        })
        break
      default:
        // 其他情况（比如 classic on-chain 交易）则将交易哈希与信息写入交易记录
        addTransaction(result.response, swapInfo, result.deadline?.toNumber())
    }

    // 返回 swap 的原始结果（供上层使用或展示）
    return result
  }, [
    // useCallback 的依赖数组：确保在这些依赖变化时重新生成函数
    account.address,
    account.isConnected,
    addOrder,
    addTransaction,
    allowedSlippage,
    selectChain,
    supportedConnectedChainId,
    swapCallback,
    swapChainId,
    trade,
  ])
}

/**
 * useSwapTransactionStatus
 * - 根据 swapResult（useSwapCallback 的返回结果）查询本地交易状态
 * - 如果 swapResult.type 为 Classic（链上交易），则传入 hash 查询交易状态
 * - 对于 UniswapX 的 offchain 订单，此钩子返回 undefined（因为其状态由订单系统管理）
 */
export function useSwapTransactionStatus(swapResult: SwapResult | undefined): TransactionStatus | undefined {
  // 仅在 classic 填充类型下，从 transaction store 中读取交易（hash）
  const transaction = useTransaction(swapResult?.type === TradeFillType.Classic ? swapResult.response.hash : undefined)
  if (!transaction) {
    return undefined
  }
  return transaction.status
}
