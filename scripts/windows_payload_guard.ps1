# SEC (audit 2026-09-03 SEC.23): helper dung chung cho provenance payload
# Windows. File nay giu ASCII de Windows PowerShell 5.1 doc on dinh khi dot-source.

if ($null -eq ("PrynXPayloadFileIdentity" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PrynXPayloadFileIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle,
        out BY_HANDLE_FILE_INFORMATION information
    );

    public static uint GetNumberOfLinks(SafeFileHandle handle)
    {
        if (handle == null || handle.IsInvalid)
            throw new InvalidOperationException("Invalid payload file handle.");

        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return information.NumberOfLinks;
    }
}
'@
}

# SEC (audit 2026-09-04 §SEC.23-L1): file handle chi giu duoc inode cua file,
# khong ghim duong dan neu ancestor bi rename. Directory handle duoi day share
# read/write nhung khong share DELETE: no ghim identity/chan rename cua chinh
# directory. Windows KHONG dung share-mode directory de cam tao child moi; exact-
# set van phai recheck va race surplus-child van la proof gap rieng.
if ($null -eq ("PrynXPayloadDirectoryIdentity" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class PrynXPayloadDirectoryIdentity
{
    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint Low;
        public uint High;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BY_HANDLE_FILE_INFORMATION
    {
        public uint FileAttributes;
        public FILETIME CreationTime;
        public FILETIME LastAccessTime;
        public FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    private const uint FILE_LIST_DIRECTORY = 0x00000001;
    private const uint FILE_READ_ATTRIBUTES = 0x00000080;
    private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
    private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        FileShare shareMode,
        IntPtr securityAttributes,
        FileMode creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetFileInformationByHandle(
        SafeFileHandle handle,
        out BY_HANDLE_FILE_INFORMATION information
    );

    public static SafeFileHandle OpenDirectory(string path)
    {
        SafeFileHandle handle = CreateFileW(
            path,
            FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
            FileShare.Read | FileShare.Write,
            IntPtr.Zero,
            FileMode.Open,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            IntPtr.Zero
        );
        if (handle.IsInvalid)
        {
            int error = Marshal.GetLastWin32Error();
            handle.Dispose();
            throw new Win32Exception(error);
        }
        return handle;
    }

    public static uint GetAttributes(SafeFileHandle handle)
    {
        if (handle == null || handle.IsInvalid)
            throw new InvalidOperationException("Invalid payload directory handle.");

        BY_HANDLE_FILE_INFORMATION information;
        if (!GetFileInformationByHandle(handle, out information))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return information.FileAttributes;
    }
}
'@
}

function Test-PrynXPayloadRelativePath {
    param([Parameter(Mandatory = $true)][string]$RelativePath)

    if ([string]::IsNullOrWhiteSpace($RelativePath) -or
        [System.IO.Path]::IsPathRooted($RelativePath) -or
        $RelativePath.Contains('\') -or
        $RelativePath.Contains(':') -or
        $RelativePath.StartsWith('/')) {
        return $false
    }
    $segments = @($RelativePath.Split('/'))
    if ($segments.Count -eq 0 -or $segments -contains '' -or
        $segments -contains '.' -or $segments -contains '..') {
        return $false
    }
    foreach ($segment in $segments) {
        if ($segment -notmatch '^[A-Za-z0-9][A-Za-z0-9._+-]*$' -or
            $segment.EndsWith('.') -or $segment.EndsWith(' ')) {
            return $false
        }
    }
    return $true
}

function Assert-PrynXNoReparsePointInPathComponents {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot) -or $fullPath.StartsWith('\\')) {
        throw "SEC: Payload path must stay on a local volume: $fullPath"
    }

    $current = $pathRoot
    $relative = $fullPath.Substring($pathRoot.Length)
    foreach ($component in @($relative.Split(
                [char[]]@('\', '/'),
                [System.StringSplitOptions]::RemoveEmptyEntries
            ))) {
        $current = Join-Path $current $component
        if (-not (Test-Path -LiteralPath $current)) { continue }
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "SEC: Payload path contains a reparse point: $current"
        }
    }
    return $fullPath
}

function Get-PrynXPayloadDirectoryChain {
    param([Parameter(Mandatory = $true)][string]$DirectoryPath)

    $fullPath = [System.IO.Path]::GetFullPath($DirectoryPath).TrimEnd(
        [char[]]@('\', '/')
    )
    $pathRoot = [System.IO.Path]::GetPathRoot($fullPath)
    if ([string]::IsNullOrWhiteSpace($pathRoot) -or $fullPath.StartsWith('\\')) {
        throw "SEC: Payload directory must stay on a local volume: $fullPath"
    }

    $paths = New-Object System.Collections.Generic.List[string]
    $current = $pathRoot
    $relative = $fullPath.Substring($pathRoot.Length)
    foreach ($component in @($relative.Split(
                [char[]]@('\', '/'),
                [System.StringSplitOptions]::RemoveEmptyEntries
            ))) {
        $current = Join-Path $current $component
        $paths.Add($current)
    }
    return $paths.ToArray()
}

function Open-PrynXPayloadDirectoryLease {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$Purpose = 'payload directory'
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw "SEC: Missing $Purpose directory: $fullPath"
    }

    $handle = $null
    try {
        $handle = [PrynXPayloadDirectoryIdentity]::OpenDirectory($fullPath)
        $attributes = [PrynXPayloadDirectoryIdentity]::GetAttributes($handle)
        if (($attributes -band [uint32][System.IO.FileAttributes]::Directory) -eq 0) {
            throw "SEC: $Purpose path is not a directory: $fullPath"
        }
        if (($attributes -band [uint32][System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "SEC: Reparse point detected for $Purpose directory: $fullPath"
        }
        return [pscustomobject]@{
            Path = $fullPath
            Stream = $handle
        }
    } catch {
        if ($null -ne $handle) { $handle.Dispose() }
        throw
    }
}

function Open-PrynXPayloadDirectoryChainLease {
    param(
        [Parameter(Mandatory = $true)][string]$DirectoryPath,
        [string]$Purpose = 'payload ancestor'
    )

    $leases = New-Object System.Collections.Generic.List[object]
    try {
        foreach ($directory in @(Get-PrynXPayloadDirectoryChain -DirectoryPath $DirectoryPath)) {
            $lease = Open-PrynXPayloadDirectoryLease `
                -Path $directory `
                -Purpose $Purpose
            $leases.Add($lease)
        }
        return [pscustomobject]@{ Leases = $leases.ToArray() }
    } catch {
        foreach ($lease in $leases) { Close-PrynXPayloadLease -Lease $lease }
        throw
    }
}

function Open-PrynXPayloadDirectoryBoundaryLease {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$Purpose = 'payload boundary'
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $rootParent = [System.IO.Path]::GetDirectoryName($rootFull)
    if ([string]::IsNullOrWhiteSpace($rootParent)) {
        throw "SEC: Payload boundary has no safe parent: $rootFull"
    }

    $leases = New-Object System.Collections.Generic.List[object]
    try {
        # Share write giu cac cay anh em (vi du Cargo target) hoat dong; viec
        # khong share DELETE ghim tung component khoi rename/thay the.
        $ancestorSet = Open-PrynXPayloadDirectoryChainLease `
            -DirectoryPath $rootParent `
            -Purpose "$Purpose ancestor"
        foreach ($ancestorLease in @($ancestorSet.Leases)) {
            $leases.Add($ancestorLease)
        }

        # Boundary chi ghim identity/chan rename cua chinh directory. No khong
        # duoc coi la primitive cam tao child tren Windows.
        $rootLease = Open-PrynXPayloadDirectoryLease `
            -Path $rootFull `
            -Purpose "$Purpose root"
        $leases.Add($rootLease)
        return [pscustomobject]@{
            Root = $rootFull
            Leases = $leases.ToArray()
        }
    } catch {
        foreach ($lease in $leases) { Close-PrynXPayloadLease -Lease $lease }
        throw
    }
}

function Open-PrynXPayloadTreeDirectoryLease {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [string]$Purpose = 'payload tree'
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $leases = New-Object System.Collections.Generic.List[object]
    try {
        $boundarySet = Open-PrynXPayloadDirectoryBoundaryLease `
            -Root $rootFull `
            -Purpose $Purpose
        foreach ($boundaryLease in @($boundarySet.Leases)) {
            $leases.Add($boundaryLease)
        }

        # Ghim root va moi descendant directory dang ton tai khoi rename. Exact-
        # set ben ngoai van bat child duoc chen truoc lan recheck cuoi.
        $directories = New-Object System.Collections.Queue
        $directories.Enqueue($rootFull)
        while ($directories.Count -gt 0) {
            $directory = [string]$directories.Dequeue()
            $children = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop |
                Sort-Object { $_.Name.ToLowerInvariant() }, Name)
            foreach ($child in $children) {
                if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                    throw "SEC: Reparse point detected in $Purpose tree: $($child.FullName)"
                }
                if (-not $child.PSIsContainer) { continue }
                $childLease = Open-PrynXPayloadDirectoryLease `
                    -Path $child.FullName `
                    -Purpose "$Purpose descendant"
                $leases.Add($childLease)
                $directories.Enqueue($child.FullName)
            }
        }
        return [pscustomobject]@{
            Root = $rootFull
            Leases = $leases.ToArray()
        }
    } catch {
        foreach ($lease in $leases) { Close-PrynXPayloadLease -Lease $lease }
        throw
    }
}

# SEC (audit 2026-09-04 SEC.20-S2): release secret scan is byte-oriented and
# streaming. It must not depend on a text extension or a size ceiling because
# Tauri ships large EXE/DLL/model/archive inputs as opaque bytes.
if ($null -eq ("System.IO.Compression.ZipArchive" -as [type])) {
    Add-Type -AssemblyName System.IO.Compression -ErrorAction Stop
}

if ($null -eq ("PrynXArchiveMagicDetector" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;

public static class PrynXArchiveMagicDetector
{
    private static bool StartsWith(byte[] value, int count, params byte[] prefix)
    {
        if (count < prefix.Length)
            return false;
        for (int index = 0; index < prefix.Length; index++)
        {
            if (value[index] != prefix[index])
                return false;
        }
        return true;
    }

    public static string Detect(Stream stream)
    {
        if (stream == null || !stream.CanRead)
            throw new InvalidOperationException("Archive detector requires a readable stream.");

        long originalPosition = 0;
        if (stream.CanSeek)
        {
            originalPosition = stream.Position;
            stream.Position = 0;
        }

        try
        {
            byte[] prefix = new byte[512];
            int prefixCount = 0;
            byte[] buffer = new byte[65536];
            byte[] tail = new byte[65557];
            int tailCount = 0;
            int tailNext = 0;
            uint signatureWindow = 0;
            long firstZipLocalHeader = -1;
            long totalBytes = 0;
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                int prefixRemaining = prefix.Length - prefixCount;
                if (prefixRemaining > 0)
                {
                    int prefixRead = Math.Min(prefixRemaining, read);
                    Buffer.BlockCopy(buffer, 0, prefix, prefixCount, prefixRead);
                    prefixCount += prefixRead;
                }
                for (int index = 0; index < read; index++)
                {
                    byte current = buffer[index];
                    signatureWindow = (signatureWindow << 8) | current;
                    if (signatureWindow == 0x504B0304U && firstZipLocalHeader < 0)
                        firstZipLocalHeader = totalBytes + index - 3;
                    if (tailCount < tail.Length)
                    {
                        tail[tailCount] = current;
                        tailCount++;
                    }
                    else
                    {
                        tail[tailNext] = current;
                        tailNext = (tailNext + 1) % tail.Length;
                    }
                }
                totalBytes += read;
            }

            byte[] orderedTail = new byte[tailCount];
            if (tailCount < tail.Length)
            {
                Buffer.BlockCopy(tail, 0, orderedTail, 0, tailCount);
            }
            else
            {
                for (int index = 0; index < tailCount; index++)
                    orderedTail[index] = tail[(tailNext + index) % tail.Length];
            }
            long validZipEocdOffset = -1;
            for (int index = orderedTail.Length - 22; index >= 0; index--)
            {
                if (orderedTail[index] != 0x50 || orderedTail[index + 1] != 0x4B ||
                    orderedTail[index + 2] != 0x05 || orderedTail[index + 3] != 0x06)
                    continue;
                int commentLength = orderedTail[index + 20] | (orderedTail[index + 21] << 8);
                if (index + 22 + commentLength != orderedTail.Length)
                    continue;
                validZipEocdOffset = totalBytes - orderedTail.Length + index;
                break;
            }

            if (StartsWith(prefix, prefixCount, 0x50, 0x4B, 0x03, 0x04) ||
                StartsWith(prefix, prefixCount, 0x50, 0x4B, 0x05, 0x06) ||
                StartsWith(prefix, prefixCount, 0x50, 0x4B, 0x07, 0x08))
                return "zip";
            if (StartsWith(prefix, prefixCount, 0x1F, 0x8B))
                return "gzip";
            if (StartsWith(prefix, prefixCount, 0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C))
                return "7z";
            if (StartsWith(prefix, prefixCount, 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x00) ||
                StartsWith(prefix, prefixCount, 0x52, 0x61, 0x72, 0x21, 0x1A, 0x07, 0x01, 0x00))
                return "rar";
            if (StartsWith(prefix, prefixCount, 0x4D, 0x53, 0x43, 0x46))
                return "cab";
            if (StartsWith(prefix, prefixCount, 0x42, 0x5A, 0x68))
                return "bzip2";
            if (StartsWith(prefix, prefixCount, 0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00))
                return "xz";
            if (prefixCount >= 262 && prefix[257] == 0x75 && prefix[258] == 0x73 &&
                prefix[259] == 0x74 && prefix[260] == 0x61 && prefix[261] == 0x72)
                return "tar";
            if (firstZipLocalHeader >= 0 && validZipEocdOffset > firstZipLocalHeader)
                return "zip-sfx";
            return String.Empty;
        }
        finally
        {
            if (stream.CanSeek)
                stream.Position = originalPosition;
        }
    }

    public static long FindFirstZipLocalHeader(Stream stream)
    {
        if (stream == null || !stream.CanRead)
            throw new InvalidOperationException("ZIP locator requires a readable stream.");
        long originalPosition = 0;
        if (stream.CanSeek)
        {
            originalPosition = stream.Position;
            stream.Position = 0;
        }
        try
        {
            byte[] buffer = new byte[65536];
            uint signatureWindow = 0;
            long absolutePosition = 0;
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
            {
                for (int index = 0; index < read; index++)
                {
                    signatureWindow = (signatureWindow << 8) | buffer[index];
                    if (signatureWindow == 0x504B0304U)
                        return absolutePosition + index - 3;
                }
                absolutePosition += read;
            }
            return -1;
        }
        finally
        {
            if (stream.CanSeek)
                stream.Position = originalPosition;
        }
    }
}
'@
}

if ($null -eq ("PrynXOffsetReadStream" -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;

public sealed class PrynXOffsetReadStream : Stream
{
    private readonly Stream inner;
    private readonly long start;

    public PrynXOffsetReadStream(Stream innerStream, long startOffset)
    {
        if (innerStream == null || !innerStream.CanRead || !innerStream.CanSeek)
            throw new ArgumentException("Offset stream requires a readable, seekable stream.");
        if (startOffset < 0 || startOffset > innerStream.Length)
            throw new ArgumentOutOfRangeException("startOffset");
        inner = innerStream;
        start = startOffset;
        inner.Position = start;
    }

    public override bool CanRead { get { return true; } }
    public override bool CanSeek { get { return true; } }
    public override bool CanWrite { get { return false; } }
    public override long Length { get { return inner.Length - start; } }
    public override long Position
    {
        get { return inner.Position - start; }
        set
        {
            if (value < 0 || value > Length)
                throw new ArgumentOutOfRangeException("value");
            inner.Position = start + value;
        }
    }

    public override void Flush() { }
    public override int Read(byte[] buffer, int offset, int count)
    {
        return inner.Read(buffer, offset, count);
    }
    public override long Seek(long offset, SeekOrigin origin)
    {
        long target;
        if (origin == SeekOrigin.Begin)
            target = offset;
        else if (origin == SeekOrigin.Current)
            target = Position + offset;
        else if (origin == SeekOrigin.End)
            target = Length + offset;
        else
            throw new ArgumentOutOfRangeException("origin");
        Position = target;
        return target;
    }
    public override void SetLength(long value) { throw new NotSupportedException(); }
    public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
}
'@
}

$script:PrynXReleaseSecretContentRegex = New-Object System.Text.RegularExpressions.Regex(
    '(?:sb_secret_[A-Za-z0-9_-]{20,}|service[_-]?role|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?|PRYNX_SUPABASE_(?:SECRET|SERVICE)_KEY|SUPABASE_SERVICE_ROLE_KEY)',
    ([System.Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant)
)

function Test-PrynXReleaseSecretName {
    param([Parameter(Mandatory = $true)][string]$Name)

    $leaf = $Name.Trim().TrimEnd([char[]]@('\', '/'))
    if ([string]::IsNullOrWhiteSpace($leaf)) { return $true }
    $leaf = [System.IO.Path]::GetFileName($leaf).ToLowerInvariant()
    $extension = [System.IO.Path]::GetExtension($leaf).ToLowerInvariant()
    if ($leaf -in @(
            '.env', '.git-credentials', '.npmrc', '.pypirc', '.netrc',
            'credentials.json'
        ) -or
        $extension -in @('.clixml', '.pem', '.pfx', '.p12', '.key') -or
        $leaf -match '(^|[._ -])(secret|secrets|credential|credentials|private[-_ ]?key|id[-_]?rsa|id[-_]?ed25519)([._ -]|$)' -or
        $leaf -match 'release[-_. ]?secrets?' -or
        $leaf -match 'service[-_. ]?role') {
        return $true
    }
    return $false
}

function Assert-PrynXReleaseSecretSafeName {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$DisplayPath
    )

    if (Test-PrynXReleaseSecretName -Name $Name) {
        throw "SEC: Release payload contains a secret-like path name: $DisplayPath"
    }
}

function Assert-PrynXNoAlternateDataStream {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DisplayPath
    )

    $streams = @(Get-Item -LiteralPath $Path -Stream * -Force -ErrorAction Stop |
        Where-Object { $_.Stream -ne ':$DATA' })
    if ($streams.Count -gt 0) {
        throw "SEC: Alternate data stream detected in release payload: $DisplayPath"
    }
}

function Invoke-PrynXReleaseSecretStreamScan {
    param(
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][string]$DisplayPath
    )

    $sha = [System.Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] (1024 * 1024)
    $empty = New-Object byte[] 0
    $carry = ''
    [long]$bytesScanned = 0
    try {
        if ($Stream.CanSeek) { $Stream.Position = 0 }
        while (($read = $Stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $null = $sha.TransformBlock($buffer, 0, $read, $buffer, 0)
            $bytesScanned += [long]$read
            $chunk = [System.Text.Encoding]::ASCII.GetString($buffer, 0, $read)
            $window = $carry + $chunk
            # Removing NUL also catches UTF-16LE/BE ASCII secret material in
            # binary resources without loading the complete file into memory.
            $windowWithoutNul = $window.Replace(([string][char]0), '')
            if ($script:PrynXReleaseSecretContentRegex.IsMatch($window) -or
                $script:PrynXReleaseSecretContentRegex.IsMatch($windowWithoutNul)) {
                throw "SEC: Release secret marker detected in payload content: $DisplayPath"
            }
            $carryLength = [Math]::Min(512, $window.Length)
            $carry = if ($carryLength -gt 0) {
                $window.Substring($window.Length - $carryLength)
            } else {
                ''
            }
        }
        $null = $sha.TransformFinalBlock($empty, 0, 0)
        return [pscustomobject]@{
            Bytes = $bytesScanned
            Sha256 = [System.BitConverter]::ToString($sha.Hash).Replace('-', '').ToLowerInvariant()
        }
    } finally {
        if ($Stream.CanSeek) { $Stream.Position = 0 }
        $sha.Dispose()
    }
}

function Get-PrynXReleaseArchiveKind {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream
    )

    # SEC (audit 2026-09-04 §SEC.20/23-L2): extension chi la fallback. Magic
    # detector doc toan stream de bat ZIP SFX co stub va nested archive doi duoi.
    $magicKind = [PrynXArchiveMagicDetector]::Detect($Stream)
    if (-not [string]::IsNullOrWhiteSpace($magicKind)) {
        return $magicKind
    }
    $extension = [System.IO.Path]::GetExtension($Path).ToLowerInvariant()
    if ($extension -in @('.zip', '.jar', '.nupkg', '.docx', '.xlsx', '.pptx')) {
        return 'zip-extension'
    }
    if (Test-PrynXOpaqueArchiveExtension -Path $Path) {
        return ('extension-' + $extension.TrimStart('.'))
    }
    return ''
}

function Test-PrynXZipArchivePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream
    )

    return ((Get-PrynXReleaseArchiveKind -Path $Path -Stream $Stream) -like 'zip*')
}

function Test-PrynXOpaqueArchiveExtension {
    param([Parameter(Mandatory = $true)][string]$Path)

    return ([System.IO.Path]::GetExtension($Path).ToLowerInvariant() -in @(
            '.7z', '.rar', '.tar', '.tgz', '.gz', '.bz2', '.xz', '.cab',
            '.iso', '.vhd', '.vhdx', '.asar'
        ))
}

function Invoke-PrynXZipReleaseSecretScan {
    param(
        [Parameter(Mandatory = $true)][System.IO.Stream]$Stream,
        [Parameter(Mandatory = $true)][string]$DisplayPath,
        [string]$ArchiveKind = 'zip'
    )

    $archive = $null
    $archiveInputStream = $Stream
    $offsetStream = $null
    [long]$expandedBytes = 0
    [long]$entryCount = 0
    try {
        $Stream.Position = 0
        if ($ArchiveKind -eq 'zip-sfx') {
            $zipOffset = [PrynXArchiveMagicDetector]::FindFirstZipLocalHeader($Stream)
            if ($zipOffset -le 0) {
                throw "SEC: ZIP SFX release payload has no safe local-header offset: $DisplayPath"
            }
            $offsetStream = [PrynXOffsetReadStream]::new($Stream, $zipOffset)
            $archiveInputStream = $offsetStream
        }
        try {
            $archive = [System.IO.Compression.ZipArchive]::new(
                $archiveInputStream,
                [System.IO.Compression.ZipArchiveMode]::Read,
                $true
            )
        } catch {
            throw "SEC: ZIP-compatible release payload cannot be inspected: $DisplayPath"
        }
        $archiveEntries = @($archive.Entries | Sort-Object { $_.FullName })
        if ($ArchiveKind -eq 'zip-sfx' -and $archiveEntries.Count -eq 0) {
            throw "SEC: ZIP SFX release payload cannot be inspected safely: $DisplayPath"
        }
        foreach ($entry in $archiveEntries) {
            $entryPath = ([string]$entry.FullName).Replace('\', '/')
            if ([string]::IsNullOrWhiteSpace($entryPath) -or
                $entryPath.StartsWith('/') -or $entryPath.Contains(':')) {
                throw "SEC: Archive contains an invalid entry path: $DisplayPath"
            }
            $segments = @($entryPath.Split('/') | Where-Object { $_ -ne '' })
            if ($segments.Count -eq 0 -or $segments -contains '.' -or
                $segments -contains '..') {
                throw "SEC: Archive contains an unsafe entry path: $DisplayPath"
            }
            foreach ($segment in $segments) {
                Assert-PrynXReleaseSecretSafeName `
                    -Name $segment `
                    -DisplayPath "$DisplayPath::$entryPath"
            }
            if ([string]::IsNullOrEmpty([string]$entry.Name)) { continue }
            $entryStream = $null
            try {
                try {
                    $entryStream = $entry.Open()
                } catch {
                    throw "SEC: Archive entry cannot be inspected safely: $DisplayPath::$entryPath"
                }
                $entryResult = Invoke-PrynXReleaseSecretStreamScan `
                    -Stream $entryStream `
                    -DisplayPath "$DisplayPath::$entryPath"
                $expandedBytes += [long]$entryResult.Bytes
                $entryCount++
            } finally {
                if ($null -ne $entryStream) { $entryStream.Dispose() }
            }

            # Mo stream thu hai: stream entry co the khong seek duoc sau raw scan.
            # Magic detector phai bat nested ZIP/SFX/gzip/7z/RAR/CAB du doi duoi.
            $archiveProbeStream = $null
            $nestedArchiveKind = ''
            try {
                try {
                    $archiveProbeStream = $entry.Open()
                } catch {
                    throw "SEC: Archive entry cannot be reopened safely: $DisplayPath::$entryPath"
                }
                $nestedArchiveKind = Get-PrynXReleaseArchiveKind `
                    -Path ([string]$entry.Name) `
                    -Stream $archiveProbeStream
            } finally {
                if ($null -ne $archiveProbeStream) { $archiveProbeStream.Dispose() }
            }
            if (-not [string]::IsNullOrWhiteSpace($nestedArchiveKind)) {
                throw "SEC: Nested archive ($nestedArchiveKind) is not independently inspectable: $DisplayPath::$entryPath"
            }
        }
        return [pscustomobject]@{
            EntryCount = $entryCount
            ExpandedBytes = $expandedBytes
        }
    } finally {
        if ($null -ne $archive) { $archive.Dispose() }
        if ($null -ne $offsetStream) { $offsetStream.Dispose() }
        $Stream.Position = 0
    }
}

function Invoke-PrynXReleaseSecretFileScan {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$DisplayPath
    )

    $fullPath = Assert-PrynXNoReparsePointInPathComponents -Path $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "SEC: Release payload file is missing: $DisplayPath"
    }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "SEC: Reparse point detected in release payload: $DisplayPath"
    }
    Assert-PrynXReleaseSecretSafeName -Name $item.Name -DisplayPath $DisplayPath
    Assert-PrynXNoAlternateDataStream -Path $fullPath -DisplayPath $DisplayPath

    $stream = $null
    try {
        # FileShare.Read blocks write/delete/replace for the complete raw/archive
        # scan while still allowing the normal build/verifier reader.
        $stream = [System.IO.File]::Open(
            $fullPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $linkCount = [PrynXPayloadFileIdentity]::GetNumberOfLinks($stream.SafeFileHandle)
        if ($linkCount -ne 1) {
            throw "SEC: Hardlink detected in release payload (link-count=$linkCount): $DisplayPath"
        }
        $rawResult = Invoke-PrynXReleaseSecretStreamScan `
            -Stream $stream `
            -DisplayPath $DisplayPath
        [long]$archiveCount = 0
        [long]$archiveEntryCount = 0
        [long]$expandedBytes = 0
        $archiveKind = Get-PrynXReleaseArchiveKind -Path $fullPath -Stream $stream
        if ($archiveKind -like 'zip*') {
            $archiveResult = Invoke-PrynXZipReleaseSecretScan `
                -Stream $stream `
                -DisplayPath $DisplayPath `
                -ArchiveKind $archiveKind
            $archiveCount = 1
            $archiveEntryCount = [long]$archiveResult.EntryCount
            $expandedBytes = [long]$archiveResult.ExpandedBytes
        } elseif (-not [string]::IsNullOrWhiteSpace($archiveKind)) {
            throw "SEC: Opaque archive format ($archiveKind) is not allowed in release payload: $DisplayPath"
        }
        $linkCountAfterScan = [PrynXPayloadFileIdentity]::GetNumberOfLinks(
            $stream.SafeFileHandle
        )
        if ($linkCountAfterScan -ne 1) {
            throw "SEC: Hardlink appeared during release payload scan (link-count=$linkCountAfterScan): $DisplayPath"
        }
        return [pscustomobject]@{
            Path = $fullPath
            Bytes = [long]$rawResult.Bytes
            Sha256 = [string]$rawResult.Sha256
            ArchiveCount = $archiveCount
            ArchiveEntryCount = $archiveEntryCount
            ExpandedBytes = $expandedBytes
        }
    } finally {
        if ($null -ne $stream) { $stream.Dispose() }
        $null = Assert-PrynXNoReparsePointInPathComponents -Path $fullPath
        Assert-PrynXNoAlternateDataStream -Path $fullPath -DisplayPath $DisplayPath
    }
}

function Add-PrynXReleaseSecretEvidenceRecord {
    param(
        [Parameter(Mandatory = $true)][System.Security.Cryptography.HashAlgorithm]$Hash,
        [Parameter(Mandatory = $true)][string]$Record
    )

    $recordBytes = [System.Text.Encoding]::UTF8.GetBytes($Record + [char]0)
    $null = $Hash.TransformBlock(
        $recordBytes,
        0,
        $recordBytes.Length,
        $recordBytes,
        0
    )
}

function Assert-PrynXReleasePayloadSecretFree {
    param(
        [string[]]$TreeRoots = @(),
        [string[]]$Files = @(),
        [string]$Purpose = 'release-payload'
    )

    $evidenceHash = [System.Security.Cryptography.SHA256]::Create()
    $empty = New-Object byte[] 0
    $seenFiles = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    $seenRoots = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    [long]$fileCount = 0
    [long]$directoryCount = 0
    [long]$rawBytes = 0
    [long]$archiveCount = 0
    [long]$archiveEntryCount = 0
    [long]$expandedBytes = 0
    try {
        Add-PrynXReleaseSecretEvidenceRecord `
            -Hash $evidenceHash `
            -Record 'PRYNX-RELEASE-SECRET-SCAN-V1'
        [int]$rootIndex = 0
        foreach ($rootPath in @($TreeRoots)) {
            $rootFull = (Assert-PrynXNoReparsePointInPathComponents -Path $rootPath).TrimEnd(
                [char[]]@('\', '/')
            )
            if (-not $seenRoots.Add($rootFull)) { continue }
            if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
                throw "SEC: Release secret scan root is missing: $rootFull"
            }
            $rootItem = Get-Item -LiteralPath $rootFull -Force -ErrorAction Stop
            if (($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "SEC: Reparse point detected at release scan root: $rootFull"
            }
            Assert-PrynXReleaseSecretSafeName `
                -Name $rootItem.Name `
                -DisplayPath "$Purpose/root-$rootIndex"
            Assert-PrynXNoAlternateDataStream `
                -Path $rootFull `
                -DisplayPath "$Purpose/root-$rootIndex"
            $directoryCount++
            Add-PrynXReleaseSecretEvidenceRecord `
                -Hash $evidenceHash `
                -Record "D|R$rootIndex"

            $directories = New-Object System.Collections.Queue
            $directories.Enqueue($rootFull)
            while ($directories.Count -gt 0) {
                $directory = [string]$directories.Dequeue()
                $children = @(Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop |
                    Sort-Object { $_.Name.ToLowerInvariant() }, Name)
                foreach ($child in $children) {
                    $relativePath = $child.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
                    $displayPath = "$Purpose/root-$rootIndex/$relativePath"
                    if (($child.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                        throw "SEC: Reparse point detected in release payload: $displayPath"
                    }
                    Assert-PrynXReleaseSecretSafeName `
                        -Name $child.Name `
                        -DisplayPath $displayPath
                    Assert-PrynXNoAlternateDataStream `
                        -Path $child.FullName `
                        -DisplayPath $displayPath
                    if ($child.PSIsContainer) {
                        $directoryCount++
                        Add-PrynXReleaseSecretEvidenceRecord `
                            -Hash $evidenceHash `
                            -Record "D|R$rootIndex/$relativePath"
                        $directories.Enqueue($child.FullName)
                        continue
                    }
                    $childFull = [System.IO.Path]::GetFullPath($child.FullName)
                    if (-not $seenFiles.Add($childFull)) { continue }
                    $fileResult = Invoke-PrynXReleaseSecretFileScan `
                        -Path $childFull `
                        -DisplayPath $displayPath
                    $fileCount++
                    $rawBytes += [long]$fileResult.Bytes
                    $archiveCount += [long]$fileResult.ArchiveCount
                    $archiveEntryCount += [long]$fileResult.ArchiveEntryCount
                    $expandedBytes += [long]$fileResult.ExpandedBytes
                    Add-PrynXReleaseSecretEvidenceRecord `
                        -Hash $evidenceHash `
                        -Record ("F|R{0}/{1}|{2}|{3}" -f @(
                                $rootIndex,
                                $relativePath,
                                [long]$fileResult.Bytes,
                                [string]$fileResult.Sha256
                            ))
                }
            }
            $rootIndex++
        }

        [int]$fileIndex = 0
        foreach ($filePath in @($Files)) {
            $fileFull = [System.IO.Path]::GetFullPath($filePath)
            if (-not $seenFiles.Add($fileFull)) { continue }
            $displayPath = "$Purpose/file-$fileIndex/$([System.IO.Path]::GetFileName($fileFull))"
            $fileResult = Invoke-PrynXReleaseSecretFileScan `
                -Path $fileFull `
                -DisplayPath $displayPath
            $fileCount++
            $rawBytes += [long]$fileResult.Bytes
            $archiveCount += [long]$fileResult.ArchiveCount
            $archiveEntryCount += [long]$fileResult.ArchiveEntryCount
            $expandedBytes += [long]$fileResult.ExpandedBytes
            Add-PrynXReleaseSecretEvidenceRecord `
                -Hash $evidenceHash `
                -Record ("F|X{0}/{1}|{2}|{3}" -f @(
                        $fileIndex,
                        [System.IO.Path]::GetFileName($fileFull),
                        [long]$fileResult.Bytes,
                        [string]$fileResult.Sha256
                    ))
            $fileIndex++
        }
        if ($fileCount -le 0) {
            throw 'SEC: Release secret scan did not inspect any file.'
        }
        $null = $evidenceHash.TransformFinalBlock($empty, 0, 0)
        return [pscustomobject]@{
            FileCount = $fileCount
            DirectoryCount = $directoryCount
            RawBytes = $rawBytes
            ArchiveCount = $archiveCount
            ArchiveEntryCount = $archiveEntryCount
            ExpandedBytes = $expandedBytes
            Sha256 = [System.BitConverter]::ToString($evidenceHash.Hash).Replace('-', '').ToLowerInvariant()
        }
    } finally {
        $evidenceHash.Dispose()
    }
}

function ConvertTo-PrynXReleaseSecretScanEvidence {
    param([Parameter(Mandatory = $true)]$ScanResult)

    if ([long]$ScanResult.FileCount -le 0 -or
        [long]$ScanResult.DirectoryCount -le 0 -or
        [long]$ScanResult.RawBytes -le 0 -or
        [long]$ScanResult.ArchiveCount -lt 0 -or
        [long]$ScanResult.ArchiveEntryCount -lt 0 -or
        [long]$ScanResult.ExpandedBytes -lt 0 -or
        [string]$ScanResult.Sha256 -notmatch '^[0-9a-f]{64}$') {
        throw 'SEC: Release secret scan evidence is incomplete.'
    }
    return ("installed-tree-v1;files={0};directories={1};raw_bytes={2};archives={3};archive_entries={4};expanded_bytes={5};sha256={6}" -f @(
            [long]$ScanResult.FileCount,
            [long]$ScanResult.DirectoryCount,
            [long]$ScanResult.RawBytes,
            [long]$ScanResult.ArchiveCount,
            [long]$ScanResult.ArchiveEntryCount,
            [long]$ScanResult.ExpandedBytes,
            [string]$ScanResult.Sha256
        ))
}

function ConvertTo-PrynXReleaseSecretScanEvidenceV2 {
    param(
        [Parameter(Mandatory = $true)][string]$InstallerSha256,
        [Parameter(Mandatory = $true)]$InstalledTreeScan,
        [Parameter(Mandatory = $true)]$NuitkaExtractionScan
    )

    if ($InstallerSha256 -notmatch '^[0-9a-fA-F]{64}$') {
        throw 'SEC: Release secret scan v2 requires a valid installer SHA-256.'
    }
    # Tai su dung validator v1 cho tung scan; v2 giu digest/counter rieng, khong
    # gop hai cay thanh mot hash khong the truy vet.
    $null = ConvertTo-PrynXReleaseSecretScanEvidence -ScanResult $InstalledTreeScan
    $null = ConvertTo-PrynXReleaseSecretScanEvidence -ScanResult $NuitkaExtractionScan
    return ("release-secret-scan-v2;installer_sha256={0};installed_files={1};installed_directories={2};installed_raw_bytes={3};installed_archives={4};installed_archive_entries={5};installed_expanded_bytes={6};installed_tree_sha256={7};extraction_files={8};extraction_directories={9};extraction_raw_bytes={10};extraction_archives={11};extraction_archive_entries={12};extraction_expanded_bytes={13};nuitka_extraction_sha256={14}" -f @(
            $InstallerSha256.ToLowerInvariant(),
            [long]$InstalledTreeScan.FileCount,
            [long]$InstalledTreeScan.DirectoryCount,
            [long]$InstalledTreeScan.RawBytes,
            [long]$InstalledTreeScan.ArchiveCount,
            [long]$InstalledTreeScan.ArchiveEntryCount,
            [long]$InstalledTreeScan.ExpandedBytes,
            [string]$InstalledTreeScan.Sha256,
            [long]$NuitkaExtractionScan.FileCount,
            [long]$NuitkaExtractionScan.DirectoryCount,
            [long]$NuitkaExtractionScan.RawBytes,
            [long]$NuitkaExtractionScan.ArchiveCount,
            [long]$NuitkaExtractionScan.ArchiveEntryCount,
            [long]$NuitkaExtractionScan.ExpandedBytes,
            [string]$NuitkaExtractionScan.Sha256
        ))
}

function Assert-PrynXReleaseSecretScanEvidenceV2 {
    param(
        [Parameter(Mandatory = $true)][string]$Evidence,
        [Parameter(Mandatory = $true)][string]$ManifestInstallerSha256,
        [Parameter(Mandatory = $true)][string]$SetupSha256
    )

    # SEC (audit 2026-09-04 SEC.20/23-L3): publisher chi chap nhan grammar
    # v2 day du. Digest installer phai dong thoi bind manifest va byte setup
    # duoc hash tu handle dang lease; counter dai qua Int64 cung fail-closed.
    foreach ($hashRecord in @(
        @{ Name = 'manifest INSTALLER_SHA256'; Value = $ManifestInstallerSha256 },
        @{ Name = 'leased setup SHA-256'; Value = $SetupSha256 }
    )) {
        if ([string]$hashRecord.Value -notmatch '^[0-9a-fA-F]{64}$') {
            throw "SEC: Invalid $($hashRecord.Name) for release secret scan v2."
        }
    }

    $pattern = '\Arelease-secret-scan-v2;' +
        'installer_sha256=([0-9a-f]{64});' +
        'installed_files=([1-9][0-9]*);' +
        'installed_directories=([1-9][0-9]*);' +
        'installed_raw_bytes=([1-9][0-9]*);' +
        'installed_archives=((?:0|[1-9][0-9]*));' +
        'installed_archive_entries=((?:0|[1-9][0-9]*));' +
        'installed_expanded_bytes=((?:0|[1-9][0-9]*));' +
        'installed_tree_sha256=([0-9a-f]{64});' +
        'extraction_files=([1-9][0-9]*);' +
        'extraction_directories=([1-9][0-9]*);' +
        'extraction_raw_bytes=([1-9][0-9]*);' +
        'extraction_archives=((?:0|[1-9][0-9]*));' +
        'extraction_archive_entries=((?:0|[1-9][0-9]*));' +
        'extraction_expanded_bytes=((?:0|[1-9][0-9]*));' +
        'nuitka_extraction_sha256=([0-9a-f]{64})\z'
    $match = [regex]::Match(
        $Evidence,
        $pattern,
        [System.Text.RegularExpressions.RegexOptions]::CultureInvariant
    )
    if (-not $match.Success) {
        throw 'SEC: Manifest RELEASE_SECRET_SCAN_V2 has an invalid exact format.'
    }

    $parsedCounters = @{}
    foreach ($groupIndex in @(2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14)) {
        [long]$parsedValue = 0
        if (-not [long]::TryParse(
            $match.Groups[$groupIndex].Value,
            [Globalization.NumberStyles]::None,
            [Globalization.CultureInfo]::InvariantCulture,
            [ref]$parsedValue
        )) {
            throw 'SEC: Manifest RELEASE_SECRET_SCAN_V2 contains an invalid counter.'
        }
        $parsedCounters[$groupIndex] = $parsedValue
    }
    if (($parsedCounters[5] -eq 0 -and
            ($parsedCounters[6] -ne 0 -or $parsedCounters[7] -ne 0)) -or
        ($parsedCounters[6] -eq 0 -and $parsedCounters[7] -ne 0) -or
        ($parsedCounters[12] -eq 0 -and
            ($parsedCounters[13] -ne 0 -or $parsedCounters[14] -ne 0)) -or
        ($parsedCounters[13] -eq 0 -and $parsedCounters[14] -ne 0)) {
        throw 'SEC: Manifest RELEASE_SECRET_SCAN_V2 contains inconsistent archive counters.'
    }

    $installerSha256 = $match.Groups[1].Value
    $manifestSha256 = $ManifestInstallerSha256.ToLowerInvariant()
    $leasedSetupSha256 = $SetupSha256.ToLowerInvariant()
    if ($installerSha256 -ne $manifestSha256 -or
        $installerSha256 -ne $leasedSetupSha256) {
        throw 'SEC: RELEASE_SECRET_SCAN_V2 is not bound to manifest and leased setup bytes.'
    }

    return [pscustomobject]@{
        Evidence = $Evidence
        InstallerSha256 = $installerSha256
        InstalledTreeSha256 = $match.Groups[8].Value
        NuitkaExtractionSha256 = $match.Groups[15].Value
    }
}

function Get-PrynXSha256FromOpenStream {
    param([Parameter(Mandatory = $true)][System.IO.FileStream]$Stream)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        $bytes = $sha.ComputeHash($Stream)
        $Stream.Position = 0
        return [System.BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

function Open-PrynXPayloadFileLease {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string]$ExpectedSha256 = '',
        $ExpectedSize = $null,
        [string]$Purpose = 'payload'
    )

    $fullPath = Assert-PrynXNoReparsePointInPathComponents -Path $Path
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "SEC: Missing $Purpose file: $fullPath"
    }
    $item = Get-Item -LiteralPath $fullPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "SEC: Reparse point detected for $Purpose file: $fullPath"
    }
    $streams = @(Get-Item -LiteralPath $fullPath -Stream * -ErrorAction Stop |
        Where-Object { $_.Stream -ne ':$DATA' })
    if ($streams.Count -gt 0) {
        throw "SEC: Alternate data stream detected for $Purpose file: $fullPath"
    }

    $stream = $null
    try {
        # FileShare.Read cho phep Tauri/Windows loader doc, nhung chan ghi, xoa
        # va replace cho toi khi lease duoc dispose.
        $stream = [System.IO.File]::Open(
            $fullPath,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            [System.IO.FileShare]::Read
        )
        $linkCount = [PrynXPayloadFileIdentity]::GetNumberOfLinks($stream.SafeFileHandle)
        if ($linkCount -ne 1) {
            throw "SEC: Hardlink detected for $Purpose file (link-count=$linkCount): $fullPath"
        }

        $actualSize = [long]$stream.Length
        if ($null -ne $ExpectedSize -and $actualSize -ne [long]$ExpectedSize) {
            throw "SEC: Size mismatch for $Purpose file: $fullPath"
        }
        if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and
            $ExpectedSha256 -notmatch '^[0-9a-fA-F]{64}$') {
            throw "SEC: Invalid expected SHA-256 for $Purpose file: $fullPath"
        }
        $actualHash = Get-PrynXSha256FromOpenStream -Stream $stream
        if (-not [string]::IsNullOrWhiteSpace($ExpectedSha256) -and
            $actualHash -ne $ExpectedSha256.ToLowerInvariant()) {
            throw "SEC: SHA-256 mismatch for $Purpose file: $fullPath"
        }

        $null = Assert-PrynXNoReparsePointInPathComponents -Path $fullPath
        $linkCountAfterHash = [PrynXPayloadFileIdentity]::GetNumberOfLinks($stream.SafeFileHandle)
        if ($linkCountAfterHash -ne 1) {
            throw "SEC: Hardlink appeared while hashing $Purpose file: $fullPath"
        }
        return [pscustomobject]@{
            Path = $fullPath
            Stream = $stream
            Sha256 = $actualHash
            Size = $actualSize
            LinkCount = $linkCountAfterHash
        }
    } catch {
        if ($null -ne $stream) { $stream.Dispose() }
        throw
    }
}

function Close-PrynXPayloadLease {
    param($Lease)

    if ($null -eq $Lease) { return }
    $items = if ($null -ne $Lease.PSObject.Properties['Leases']) {
        @($Lease.Leases)
    } else {
        @($Lease)
    }
    foreach ($item in $items) {
        if ($null -ne $item -and $null -ne $item.PSObject.Properties['Stream'] -and
            $null -ne $item.Stream) {
            try { $item.Stream.Dispose() } catch {}
        }
    }
}

function Open-PrynXReleasePublishLeaseSet {
    param(
        [Parameter(Mandatory = $true)][string]$StageRoot,
        [Parameter(Mandatory = $true)][string]$SetupPath,
        [Parameter(Mandatory = $true)][string]$SetupSha256,
        [Parameter(Mandatory = $true)][string]$SignaturePath,
        [Parameter(Mandatory = $true)][string]$SignatureSha256,
        [Parameter(Mandatory = $true)][string]$LatestPath,
        [Parameter(Mandatory = $true)][string]$LatestSha256,
        [Parameter(Mandatory = $true)][string]$ManifestPath
    )

    # SEC (audit 2026-09-04 SEC.20/23-L3): gh phai doc dung ba byte-set
    # da hash va dung manifest da gate. Directory handle ghim path/ancestor;
    # no khong cam tao child moi, nhung gh chi nhan ba path explicit ben duoi.
    $leases = New-Object System.Collections.Generic.List[object]
    $setupLease = $null
    $signatureLease = $null
    $latestLease = $null
    $manifestLease = $null
    try {
        $stageFull = [System.IO.Path]::GetFullPath($StageRoot).TrimEnd(
            [char[]]@('\', '/')
        )
        $seenAssets = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        foreach ($assetPath in @($SetupPath, $SignaturePath, $LatestPath)) {
            $assetFull = [System.IO.Path]::GetFullPath($assetPath)
            $assetParent = [System.IO.Path]::GetDirectoryName($assetFull).TrimEnd(
                [char[]]@('\', '/')
            )
            if (-not [string]::Equals(
                $assetParent,
                $stageFull,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                throw "SEC: Release asset is outside the leased stage root: $assetFull"
            }
            if (-not $seenAssets.Add($assetFull)) {
                throw "SEC: Duplicate release asset path: $assetFull"
            }
        }

        $stageBoundary = Open-PrynXPayloadDirectoryBoundaryLease `
            -Root $stageFull `
            -Purpose 'release publish stage'
        foreach ($directoryLease in @($stageBoundary.Leases)) {
            $leases.Add($directoryLease)
        }

        $manifestFull = [System.IO.Path]::GetFullPath($ManifestPath)
        if ($seenAssets.Contains($manifestFull)) {
            throw 'SEC: Release manifest must not alias a staged asset.'
        }
        $manifestDirectorySet = Open-PrynXPayloadDirectoryChainLease `
            -DirectoryPath ([System.IO.Path]::GetDirectoryName($manifestFull)) `
            -Purpose 'release manifest ancestor'
        foreach ($directoryLease in @($manifestDirectorySet.Leases)) {
            $leases.Add($directoryLease)
        }

        $setupLease = Open-PrynXPayloadFileLease `
            -Path $SetupPath `
            -ExpectedSha256 $SetupSha256 `
            -Purpose 'staged setup'
        $leases.Add($setupLease)
        $signatureLease = Open-PrynXPayloadFileLease `
            -Path $SignaturePath `
            -ExpectedSha256 $SignatureSha256 `
            -Purpose 'staged updater signature'
        $leases.Add($signatureLease)
        $latestLease = Open-PrynXPayloadFileLease `
            -Path $LatestPath `
            -ExpectedSha256 $LatestSha256 `
            -Purpose 'staged latest manifest'
        $leases.Add($latestLease)
        $manifestLease = Open-PrynXPayloadFileLease `
            -Path $manifestFull `
            -Purpose 'release evidence manifest'
        $leases.Add($manifestLease)

        return [pscustomobject]@{
            StageRoot = $stageFull
            Setup = $setupLease
            Signature = $signatureLease
            Latest = $latestLease
            Manifest = $manifestLease
            Leases = $leases.ToArray()
        }
    } catch {
        foreach ($lease in $leases) {
            Close-PrynXPayloadLease -Lease $lease
        }
        throw
    }
}

function Read-PrynXTesseractPayloadLock {
    param([Parameter(Mandatory = $true)][string]$Path)

    $lockLease = Open-PrynXPayloadFileLease -Path $Path -Purpose 'Tesseract lock'
    try {
        $lockLease.Stream.Position = 0
        $utf8Strict = New-Object System.Text.UTF8Encoding($false, $true)
        $reader = New-Object System.IO.StreamReader(
            $lockLease.Stream,
            $utf8Strict,
            $true,
            4096,
            $true
        )
        try {
            $document = $reader.ReadToEnd() | ConvertFrom-Json -ErrorAction Stop
        } finally {
            $reader.Dispose()
            $lockLease.Stream.Position = 0
        }

        [int]$fileCount = 0
        $installerSha = [string]$document.provenance.installer.sha256
        $installerUrl = [string]$document.provenance.installer.url
        if ($null -eq $document -or [int]$document.schema_version -ne 1 -or
            [string]$document.component_id -ne 'tesseract' -or
            [string]$document.component_version -notmatch '^5\.4\.0\.20240606$' -or
            $installerSha -notmatch '^[0-9a-fA-F]{64}$' -or
            -not $installerUrl.StartsWith('https://github.com/UB-Mannheim/tesseract/releases/download/', [System.StringComparison]::Ordinal) -or
            $null -eq $document.files -or $null -eq $document.file_count -or
            -not [int]::TryParse([string]$document.file_count, [ref]$fileCount)) {
            throw 'SEC: Tesseract payload lock has an invalid schema or provenance.'
        }

        $entries = @($document.files)
        if ($fileCount -le 0 -or $fileCount -ne $entries.Count) {
            throw 'SEC: Tesseract payload lock file_count does not match files.'
        }
        $entryMap = @{}
        $normalizedEntries = New-Object System.Collections.Generic.List[object]
        foreach ($entry in $entries) {
            $relativePath = [string]$entry.path
            $hash = [string]$entry.sha256
            $origin = [string]$entry.origin
            [long]$size = 0
            if (-not (Test-PrynXPayloadRelativePath -RelativePath $relativePath) -or
                $hash -notmatch '^[0-9a-fA-F]{64}$' -or
                $null -eq $entry.size -or
                -not [long]::TryParse([string]$entry.size, [ref]$size) -or
                $size -lt 0 -or
                $origin -notin @('ub-mannheim-installer', 'tesseract-tessdata-commit') -or
                $entryMap.ContainsKey($relativePath)) {
                throw 'SEC: Tesseract payload lock contains an invalid or duplicate entry.'
            }
            if (($relativePath -ieq 'tessdata/vie.traineddata') -ne
                ($origin -eq 'tesseract-tessdata-commit')) {
                throw 'SEC: Tesseract Vietnamese language provenance is inconsistent.'
            }
            $normalized = [pscustomobject]@{
                Path = $relativePath
                Hash = $hash.ToLowerInvariant()
                Size = $size
                Origin = $origin
            }
            $entryMap[$relativePath] = $normalized
            $normalizedEntries.Add($normalized)
        }

        foreach ($requiredPath in @(
            'tesseract.exe',
            'tessdata/eng.traineddata',
            'tessdata/vie.traineddata'
        )) {
            if (-not $entryMap.ContainsKey($requiredPath)) {
                throw "SEC: Tesseract payload lock is missing required path: $requiredPath"
            }
        }
        $supplements = @($document.provenance.supplements)
        if ($supplements.Count -ne 1 -or
            [string]$supplements[0].path -ne 'tessdata/vie.traineddata' -or
            [string]$supplements[0].commit -notmatch '^[0-9a-fA-F]{40}$' -or
            [string]$supplements[0].sha256 -ne $entryMap['tessdata/vie.traineddata'].Hash) {
            throw 'SEC: Tesseract supplemental provenance is invalid.'
        }

        return [pscustomobject]@{
            Path = $lockLease.Path
            LockSha256 = $lockLease.Sha256
            Version = [string]$document.component_version
            InstallerSha256 = $installerSha.ToLowerInvariant()
            Entries = @($normalizedEntries | Sort-Object { $_.Path })
            EntryMap = $entryMap
            LockLease = $lockLease
            Document = $document
        }
    } catch {
        Close-PrynXPayloadLease -Lease $lockLease
        throw
    }
}

function Assert-PrynXPayloadRootExactSet {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][object[]]$Entries
    )

    $rootFull = (Assert-PrynXNoReparsePointInPathComponents -Path $Root).TrimEnd([char[]]@('\', '/'))
    if (-not (Test-Path -LiteralPath $rootFull -PathType Container)) {
        throw "SEC: Payload root is missing or is not a directory: $rootFull"
    }
    $expectedFiles = @{}
    $expectedDirectories = @{}
    foreach ($entry in $Entries) {
        $relativePath = [string]$entry.Path
        if (-not (Test-PrynXPayloadRelativePath -RelativePath $relativePath) -or
            $expectedFiles.ContainsKey($relativePath)) {
            throw 'SEC: Invalid or duplicate expected payload path.'
        }
        $expectedFiles[$relativePath] = $entry
        $segments = @($relativePath.Split('/'))
        if ($segments.Count -gt 1) {
            for ($index = 1; $index -lt $segments.Count; $index++) {
                $expectedDirectories[($segments[0..($index - 1)] -join '/')] = $true
            }
        }
    }

    $seenFiles = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Recurse -Force -ErrorAction Stop)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "SEC: Reparse point detected in payload tree: $($item.FullName)"
        }
        $relativePath = $item.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
        if (-not (Test-PrynXPayloadRelativePath -RelativePath $relativePath)) {
            throw "SEC: Invalid path in payload tree: $relativePath"
        }
        if ($item.PSIsContainer) {
            if (-not $expectedDirectories.ContainsKey($relativePath)) {
                throw "SEC: Surplus directory in payload tree: $relativePath"
            }
            continue
        }
        $streams = @(Get-Item -LiteralPath $item.FullName -Stream * -ErrorAction Stop |
            Where-Object { $_.Stream -ne ':$DATA' })
        if ($streams.Count -gt 0) {
            throw "SEC: Alternate data stream detected in payload tree: $relativePath"
        }
        if (-not $expectedFiles.ContainsKey($relativePath)) {
            throw "SEC: Surplus file in payload tree: $relativePath"
        }
        $seenFiles[$relativePath] = $true
    }
    foreach ($relativePath in $expectedFiles.Keys) {
        if (-not $seenFiles.ContainsKey($relativePath)) {
            throw "SEC: Missing file in payload tree: $relativePath"
        }
    }
}

function Open-PrynXPayloadLeaseSet {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][object[]]$Entries,
        [string]$Purpose = 'payload'
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $leases = New-Object System.Collections.Generic.List[object]
    try {
        # SEC (audit 2026-09-04 §SEC.23-L1): ghim identity ancestor/root/cac
        # descendant dang co truoc exact-set. File leases ben duoi cam sua/xoa
        # file expected; Windows directory share-mode khong cam tao child moi.
        $directoryLeaseSet = Open-PrynXPayloadTreeDirectoryLease `
            -Root $rootFull `
            -Purpose $Purpose
        foreach ($directoryLease in @($directoryLeaseSet.Leases)) {
            $leases.Add($directoryLease)
        }

        Assert-PrynXPayloadRootExactSet -Root $rootFull -Entries $Entries
        foreach ($entry in @($Entries | Sort-Object { $_.Path })) {
            $relativeNative = ([string]$entry.Path).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
            $filePath = Join-Path $rootFull $relativeNative
            $lease = Open-PrynXPayloadFileLease `
                -Path $filePath `
                -ExpectedSha256 ([string]$entry.Hash) `
                -ExpectedSize ([long]$entry.Size) `
                -Purpose "$Purpose/$($entry.Path)"
            $leases.Add($lease)
        }
        Assert-PrynXPayloadRootExactSet -Root $rootFull -Entries $Entries
        return [pscustomobject]@{
            Root = $rootFull
            # Generic List khong duoc @()-debasing on dinh tren ca Windows
            # PowerShell 5.1 va pwsh 7; ToArray giu dung tung lease object.
            Leases = $leases.ToArray()
        }
    } catch {
        foreach ($lease in $leases) { Close-PrynXPayloadLease -Lease $lease }
        throw
    }
}

function Copy-PrynXTesseractPayload {
    param(
        [Parameter(Mandatory = $true)]$Lock,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )

    $sourceFull = (Assert-PrynXNoReparsePointInPathComponents -Path $SourceRoot).TrimEnd([char[]]@('\', '/'))
    if (-not (Test-Path -LiteralPath $sourceFull -PathType Container)) {
        throw "SEC: Tesseract source root is missing: $sourceFull"
    }
    $destinationFull = [System.IO.Path]::GetFullPath($DestinationRoot).TrimEnd([char[]]@('\', '/'))
    if (Test-Path -LiteralPath $destinationFull) {
        $existing = @(Get-ChildItem -LiteralPath $destinationFull -Force -ErrorAction Stop)
        if ($existing.Count -gt 0) {
            throw "SEC: Tesseract destination must be empty: $destinationFull"
        }
    } else {
        New-Item -ItemType Directory -Path $destinationFull -ErrorAction Stop | Out-Null
    }
    $null = Assert-PrynXNoReparsePointInPathComponents -Path $destinationFull

    foreach ($entry in @($Lock.Entries | Sort-Object { $_.Path })) {
        $relativeNative = ([string]$entry.Path).Replace('/', [System.IO.Path]::DirectorySeparatorChar)
        $sourcePath = Join-Path $sourceFull $relativeNative
        $destinationPath = Join-Path $destinationFull $relativeNative
        $sourceLease = Open-PrynXPayloadFileLease `
            -Path $sourcePath `
            -ExpectedSha256 ([string]$entry.Hash) `
            -ExpectedSize ([long]$entry.Size) `
            -Purpose "Tesseract source/$($entry.Path)"
        try {
            $destinationParent = Split-Path -Parent $destinationPath
            if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
                New-Item -ItemType Directory -Path $destinationParent -Force -ErrorAction Stop | Out-Null
            }
            $null = Assert-PrynXNoReparsePointInPathComponents -Path $destinationParent
            $destinationStream = [System.IO.File]::Open(
                $destinationPath,
                [System.IO.FileMode]::CreateNew,
                [System.IO.FileAccess]::Write,
                [System.IO.FileShare]::None
            )
            try {
                $sourceLease.Stream.Position = 0
                $sourceLease.Stream.CopyTo($destinationStream)
                $destinationStream.Flush($true)
            } finally {
                $destinationStream.Dispose()
            }
        } finally {
            Close-PrynXPayloadLease -Lease $sourceLease
        }
    }

    $verificationLease = Open-PrynXPayloadLeaseSet `
        -Root $destinationFull `
        -Entries $Lock.Entries `
        -Purpose 'Tesseract staging'
    Close-PrynXPayloadLease -Lease $verificationLease
    return $destinationFull
}

function Assert-PrynXTesseractManifestMatchesLock {
    param(
        [Parameter(Mandatory = $true)]$Manifest,
        [Parameter(Mandatory = $true)]$Lock
    )

    [int]$declaredCount = 0
    if ($null -eq $Manifest -or [int]$Manifest.version -ne 2 -or
        [string]$Manifest.component_id -ne 'tesseract' -or
        [string]$Manifest.component_version -ne [string]$Lock.Version -or
        [string]$Manifest.source_lock_sha256 -ne [string]$Lock.LockSha256 -or
        $null -eq $Manifest.files -or $null -eq $Manifest.file_count -or
        -not [int]::TryParse([string]$Manifest.file_count, [ref]$declaredCount)) {
        throw 'SEC: Payload manifest is not bound to the trusted Tesseract lock.'
    }
    $manifestEntries = @($Manifest.files)
    if ($declaredCount -ne $manifestEntries.Count -or
        $declaredCount -ne @($Lock.Entries).Count) {
        throw 'SEC: Payload manifest file_count does not match the trusted lock.'
    }

    $manifestMap = @{}
    foreach ($entry in $manifestEntries) {
        $relativePath = [string]$entry.path
        $hash = [string]$entry.sha256
        [long]$size = 0
        if (-not $relativePath.StartsWith('tesseract/', [System.StringComparison]::Ordinal) -or
            -not (Test-PrynXPayloadRelativePath -RelativePath $relativePath) -or
            $hash -notmatch '^[0-9a-fA-F]{64}$' -or
            $null -eq $entry.size -or
            -not [long]::TryParse([string]$entry.size, [ref]$size) -or
            $size -lt 0 -or $manifestMap.ContainsKey($relativePath)) {
            throw 'SEC: Payload manifest contains an invalid or duplicate entry.'
        }
        $manifestMap[$relativePath] = [pscustomobject]@{
            Hash = $hash.ToLowerInvariant()
            Size = $size
        }
    }
    foreach ($lockEntry in $Lock.Entries) {
        $relativePath = 'tesseract/' + [string]$lockEntry.Path
        if (-not $manifestMap.ContainsKey($relativePath) -or
            [string]$manifestMap[$relativePath].Hash -ne [string]$lockEntry.Hash -or
            [long]$manifestMap[$relativePath].Size -ne [long]$lockEntry.Size) {
            throw "SEC: Payload manifest drifted from the trusted lock: $relativePath"
        }
    }
    return $manifestMap
}
