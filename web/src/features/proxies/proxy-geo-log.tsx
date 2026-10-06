import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { VmProxySnap } from '@/types/panel-vm'
import { api } from '@/lib/api'
import { Button } from '@/components/ui/button'

export type GeoCheck = {
  id: number
  proxy_id: string
  proxy_label: string | null
  checked_at: string
  ip: string | null
  country_code: string | null
  region: string | null
  city: string | null
  isp: string | null
  latency_ms: number | null
  result: string
  action: string | null
  error: string | null
}

export function ProxyGeoLog({ proxies }: { proxies: VmProxySnap[] }) {
  const [proxyId, setProxyId] = useState('')
  const [result, setResult] = useState('')
  const [before, setBefore] = useState<number | null>(null)
  const [history, setHistory] = useState<GeoCheck[]>([])
  const params = new URLSearchParams()
  if (proxyId) params.set('proxy_id', proxyId)
  if (result) params.set('result', result)
  if (before) params.set('before_id', String(before))
  const checks = useQuery({
    queryKey: ['panel', 'proxies', 'geo-checks', proxyId, result, before],
    queryFn: () =>
      api<{ items: GeoCheck[]; next_before_id: number | null }>(
        `/api/panel/proxies/geo-checks?${params}`
      ),
    refetchInterval: 30000,
  })
  const rows = [...history, ...(checks.data?.items || [])]
  const changeFilters = (id: string, status: string) => {
    setProxyId(id)
    setResult(status)
    setBefore(null)
    setHistory([])
  }
  return (
    <div className='space-y-3 overflow-x-auto rounded-lg border p-4'>
      <div className='flex gap-2'>
        <select
          className='rounded border bg-background p-2 text-xs'
          value={proxyId}
          onChange={(e) => changeFilters(e.target.value, result)}
          aria-label='筛选代理'
        >
          <option value=''>全部代理</option>
          {proxies.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label || p.id}
            </option>
          ))}
        </select>
        <select
          className='rounded border bg-background p-2 text-xs'
          value={result}
          onChange={(e) => changeFilters(proxyId, e.target.value)}
          aria-label='筛选结果'
        >
          <option value=''>全部结果</option>
          <option value='baseline'>基准</option>
          <option value='same'>未变化</option>
          <option value='changed'>地区变化</option>
          <option value='error'>失败</option>
        </select>
      </div>
      {checks.error && (
        <p className='text-xs text-destructive'>{checks.error.message}</p>
      )}
      <table className='w-full min-w-[900px] text-left text-xs'>
        <thead>
          <tr>
            {[
              '时间',
              '代理',
              '出口 IP',
              '国家·地区·城市',
              'ISP',
              '耗时',
              '结果',
              '处理',
              '错误',
            ].map((name) => (
              <th key={name} className='p-2'>
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className='border-t'>
              <td className='p-2'>
                {new Date(row.checked_at).toLocaleString()}
              </td>
              <td className='p-2'>{row.proxy_label || row.proxy_id}</td>
              <td className='p-2'>{row.ip || '-'}</td>
              <td className='p-2'>
                {[row.country_code, row.region, row.city]
                  .filter(Boolean)
                  .join(' · ') || '-'}
              </td>
              <td className='p-2'>{row.isp || '-'}</td>
              <td className='p-2'>
                {row.latency_ms == null ? '-' : `${row.latency_ms}ms`}
              </td>
              <td className='p-2'>
                <span
                  className={row.result === 'changed' ? 'text-destructive' : ''}
                >
                  {(
                    {
                      baseline: '基准',
                      same: '未变化',
                      changed: '地区变化',
                      error: '失败',
                    } as Record<string, string>
                  )[row.result] || row.result}
                </span>
              </td>
              <td className='p-2'>{row.action || '-'}</td>
              <td className='p-2'>{row.error || '-'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {checks.data?.next_before_id && (
        <Button
          size='sm'
          variant='outline'
          onClick={() => {
            setHistory(rows)
            setBefore(checks.data?.next_before_id || null)
          }}
        >
          加载更多
        </Button>
      )}
    </div>
  )
}
