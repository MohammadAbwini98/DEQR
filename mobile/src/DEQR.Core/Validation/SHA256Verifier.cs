using System.Security.Cryptography;

namespace DEQR.Core.Validation;

public static class SHA256Verifier
{
    public static byte[] ComputeHash(ReadOnlySpan<byte> data)
    {
        using SHA256 sha256 = SHA256.Create();
        return sha256.ComputeHash(data.ToArray());
    }

    public static bool VerifyHash(ReadOnlySpan<byte> data, ReadOnlySpan<byte> expectedHash)
    {
        if (expectedHash.Length != 32)
        {
            return false;
        }

        byte[] actualHash = ComputeHash(data);
        return CryptographicOperations.FixedTimeEquals(actualHash, expectedHash);
    }

    public static bool Verify(ReadOnlySpan<byte> data, ReadOnlySpan<byte> expectedHash)
        => VerifyHash(data, expectedHash);
}
