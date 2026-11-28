import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { ApiKeyItem } from '@/types/panel-keys'
import type {
  JevApiKeyScopeMode,
  JevInterceptConfig,
} from '@/types/panel-routing'
import { ChevronDown } from 'lucide-react'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { cn } from '@/lib/utils'
import { useServerDraft } from '@/hooks/use-server-draft'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { apiKeysQueryOptions } from '@/features/keys/queries'
import { SaveBar } from '@/features/settings/save-bar'
import { Group } from './blocks'
import { jevInterceptQueryOptions } from './queries'

type Draft = {
  mode: JevApiKeyScopeMode
  ids: string[]
}

const MODES: { value: JevApiKeyScopeMode; title: string; desc: string }[] = [
  { value: 'all', title: '全部', desc: '所有 API Key 的请求都送审。' },
  {
    value: 'include',
    title: '只审核选中的 Key',
    desc: '没选任何 Key 时等同全部。没有 API Key 的请求不审。',
  },
  {
    value: 'exclude',
    title: '不审核选中的 Key',
    desc: '选中的 Key 跳过决策模型（会话与工具审核），正则和蒸馏照常；其余照审。',
  },
]

function modeOf(raw: unknown): JevApiKeyScopeMode {
  return raw === 'include' || raw === 'exclude' ? raw : 'all'
}

function draftOf(data: JevInterceptConfig): Draft {
  return {
    mode: modeOf(data.api_key_scope_mode),
    ids: data.api_key_ids || [],
  }
}

function sameDraft(left: Draft, right: Draft) {
  return (
    left.mode === right.mode &&
    [...left.ids].sort().join('\n') === [...right.ids].sort().join('\n')
  )
}

function draftDiffers(left: Draft, right: Draft) {
  return !sameDraft(left, right)
}

function keyLabel(key: ApiKeyItem) {
  return String(key.name || '').trim() || '未命名'
}

/**
 * 决策模型关的 API Key 范围。题库、阈值全局一套，这里只决定哪些
 * 下游 Key 的请求送审；会话审核和工具审核共用。
 */
export function ApiKeyScopeSettings({
  onDirtyChange,
}: {
  onDirtyChange: (dirty: boolean) => void
}) {
  const qc = useQueryClient()
  const q = useQuery(jevInterceptQueryOptions())
  const keysQ = useQuery(apiKeysQueryOptions())
  const [draft, setDraft] = useServerDraft(q.data, draftOf, draftDiffers)
  const [open, setOpen] = useState(false)

  const saved = q.data ? draftOf(q.data) : null
  const dirty = !!draft && !!saved && !sameDraft(draft, saved)
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])

  const save = useMutation({
    mutationFn: () => {
      if (!draft) throw new Error('没有可保存的配置')
      return api<JevInterceptConfig>('/api/panel/jev-intercept', {
        method: 'PUT',
        body: JSON.stringify({
          api_key_scope_mode: draft.mode,
          api_key_ids: draft.ids,
        }),
      })
    },
    onSuccess: (data) => {
      toast.success('已保存 API Key 范围')
      setDraft(draftOf(data))
      qc.setQueryData(jevInterceptQueryOptions().queryKey, data)
    },
    onError: (error: Error) => toast.error(error.message),
  })

  if (q.error) {
    return (
      <p
        className='rounded-xl border px-4 py-3 text-sm text-destructive'
        role='alert'
      >
        {(q.error as Error).message}
      </p>
    )
  }
  if (!draft) {
    return <div className='h-12 animate-pulse rounded-xl bg-muted/40' />
  }

  const keys = keysQ.data?.keys || []
  const known = new Set(keys.map((key) => key.id))
  const missing = draft.ids.filter((id) => !known.has(id))
  const picked = draft.ids.length
  const summary =
    draft.mode === 'all' || (draft.mode === 'include' && !picked)
      ? '全部 Key'
      : draft.mode === 'include'
        ? `只审核 ${picked} 个 Key`
        : `不审核 ${picked} 个 Key`
  const shown = open || dirty

  const toggle = (id: string) =>
    setDraft({
      ...draft,
      ids: draft.ids.includes(id)
        ? draft.ids.filter((item) => item !== id)
        : [...draft.ids, id],
    })

  return (
    <Collapsible
      open={shown}
      onOpenChange={(next) => {
        if (!next && dirty) return
        setOpen(next)
      }}
      className='rounded-xl border bg-card'
    >
      <CollapsibleTrigger className='flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-3 text-left transition-colors duration-200 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'>
        <span className='shrink-0 text-sm font-semibold'>API Key 范围</span>
        <span className='flex min-w-0 items-center gap-2 text-xs text-muted-foreground'>
          <span className='truncate'>{summary}</span>
          <ChevronDown
            className={cn(
              'size-4 shrink-0 transition-transform duration-200',
              shown && 'rotate-180'
            )}
            aria-hidden='true'
          />
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className='space-y-6 border-t px-4 py-4'>
        <p className='text-xs leading-5 text-muted-foreground'>
          题库与阈值全局一套；这里只决定哪些 API Key
          的请求送审，会话审核和工具审核都按此范围。
        </p>

        <RadioGroup
          value={draft.mode}
          onValueChange={(value) => setDraft({ ...draft, mode: modeOf(value) })}
          className='grid gap-2 sm:grid-cols-3'
        >
          {MODES.map((item) => (
            <Label
              key={item.value}
              className='flex cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 p-3 font-normal transition-colors hover:border-border has-data-[state=checked]:border-select-border has-data-[state=checked]:bg-select-surface'
            >
              <RadioGroupItem value={item.value} className='mt-0.5' />
              <span className='min-w-0 flex-1 space-y-1'>
                <span className='block text-sm leading-none font-medium'>
                  {item.title}
                </span>
                <span className='block text-xs leading-snug text-muted-foreground'>
                  {item.desc}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>

        {draft.mode !== 'all' ? (
          <Group
            title='API Key'
            hint={`已选 ${picked} 个。`}
            action={
              picked ? (
                <Button
                  type='button'
                  size='sm'
                  variant='ghost'
                  className='cursor-pointer text-xs'
                  onClick={() => setDraft({ ...draft, ids: [] })}
                >
                  清空
                </Button>
              ) : undefined
            }
          >
            {keysQ.error ? (
              <p className='text-xs text-destructive' role='alert'>
                {(keysQ.error as Error).message}
              </p>
            ) : keysQ.isPending ? (
              <div className='h-10 animate-pulse rounded-lg bg-muted/40' />
            ) : keys.length || missing.length ? (
              <ul className='max-h-80 space-y-1 overflow-y-auto'>
                {keys.map((key) => (
                  <li key={key.id}>
                    <Label className='flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 font-normal hover:bg-muted/40'>
                      <Checkbox
                        checked={draft.ids.includes(key.id)}
                        onCheckedChange={() => toggle(key.id)}
                      />
                      <span className='min-w-0 truncate text-sm'>
                        {keyLabel(key)}
                      </span>
                      <span className='shrink-0 font-mono text-xs text-muted-foreground'>
                        {key.id}
                      </span>
                      {key.status && key.status !== 'active' ? (
                        <span className='shrink-0 text-xs text-muted-foreground'>
                          {key.status}
                        </span>
                      ) : null}
                    </Label>
                  </li>
                ))}
                {missing.map((id) => (
                  <li key={id}>
                    <Label className='flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 font-normal hover:bg-muted/40'>
                      <Checkbox checked onCheckedChange={() => toggle(id)} />
                      <span className='min-w-0 truncate font-mono text-xs text-muted-foreground'>
                        已删除 {id}
                      </span>
                    </Label>
                  </li>
                ))}
              </ul>
            ) : (
              <p className='text-xs text-muted-foreground'>还没有 API Key。</p>
            )}
          </Group>
        ) : null}

        {draft.mode === 'include' && !picked ? (
          <p className='text-xs leading-5 text-muted-foreground'>
            没选任何 Key，按「全部」处理。
          </p>
        ) : null}

        {dirty ? (
          <SaveBar
            saving={save.isPending}
            onSave={() => save.mutate()}
            onDiscard={() => q.data && setDraft(draftOf(q.data))}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  )
}
