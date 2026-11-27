import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '@/components/setting-row'

type LogsPaneProps = {
  value: Record<string, unknown>
  onChange: (next: Record<string, unknown>) => void
}

export function LogsPane({ value: logging, onChange }: LogsPaneProps) {
  const archive = (logging.body_archive ?? {}) as Record<string, unknown>
  const setArchive = (patch: Record<string, unknown>) =>
    onChange({ ...logging, body_archive: { ...archive, ...patch } })
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>日志保留</CardTitle>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow label='记录模式'>
            <Select
              value={String(logging.mode || 'normal')}
              onValueChange={(mode) => onChange({ ...logging, mode })}
            >
              <SelectTrigger className='w-40'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='off'>关闭</SelectItem>
                <SelectItem value='normal'>普通</SelectItem>
                <SelectItem value='debug'>Debug</SelectItem>
              </SelectContent>
            </Select>
          </SettingRow>
          <SettingRow label='保留天数'>
            <Input
              className='w-24'
              type='number'
              min={1}
              max={90}
              value={Number(logging.retain_days ?? 7)}
              onChange={(event) =>
                onChange({
                  ...logging,
                  retain_days: Number(event.target.value),
                })
              }
            />
          </SettingRow>
          <SettingRow
            label='Debug 保留天数'
            desc='request_log_debug 行。不超过上面的保留天数。'
          >
            <Input
              className='w-24'
              type='number'
              min={1}
              max={90}
              value={Number(logging.debug_retain_days ?? 3)}
              onChange={(event) =>
                onChange({
                  ...logging,
                  debug_retain_days: Number(event.target.value),
                })
              }
            />
          </SettingRow>
          <SettingRow
            label='存储上限 MB'
            desc='0 表示不按体积清理。超出删最旧 debug 行。'
          >
            <Input
              className='w-24'
              type='number'
              min={0}
              value={Number(logging.max_mb ?? 2048)}
              onChange={(event) =>
                onChange({
                  ...logging,
                  max_mb: Number(event.target.value),
                })
              }
            />
          </SettingRow>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>完整请求体文件</CardTitle>
        </CardHeader>
        <CardContent className='divide-y'>
          <SettingRow
            label='保存完整请求体'
            desc='自动模式审核请求、状态不是 200、返回里有 Usage Policy 的请求，把完整请求体压缩存到 data/request-logs/bodies，在日志详情下载。不受上面的存储上限限制。'
          >
            <Switch
              checked={archive.enabled === true}
              onCheckedChange={(enabled) => setArchive({ enabled })}
            />
          </SettingRow>
          <SettingRow
            label='文件保留天数'
            desc='按文件写入时间计算，关闭后旧文件也照常到期删除。'
          >
            <Input
              className='w-24'
              type='number'
              min={1}
              max={90}
              value={Number(archive.retain_days ?? 3)}
              onChange={(event) =>
                setArchive({ retain_days: Number(event.target.value) })
              }
            />
          </SettingRow>
          <SettingRow
            label='文件夹上限 MB'
            desc='0 表示不限。超出时从最旧的文件删起。'
          >
            <Input
              className='w-24'
              type='number'
              min={0}
              value={Number(archive.max_mb ?? 3072)}
              onChange={(event) =>
                setArchive({ max_mb: Number(event.target.value) })
              }
            />
          </SettingRow>
        </CardContent>
      </Card>
    </>
  )
}
