namespace DEQR.Core.PRNG;

public sealed class RobustSoliton
{
    private readonly int _k;
    private readonly double[] _cdf;

    public RobustSoliton(int k, double c = 0.1, double delta = 0.05)
    {
        if (k <= 0) throw new ArgumentOutOfRangeException(nameof(k));
        if (c <= 0) throw new ArgumentOutOfRangeException(nameof(c));
        if (delta <= 0 || delta >= 1) throw new ArgumentOutOfRangeException(nameof(delta));

        _k = k;
        _cdf = new double[k + 1];
        InitDistribution(c, delta);
    }

    private void InitDistribution(double c, double delta)
    {
        double s = c * Math.Log(_k / delta) * Math.Sqrt(_k);
        double[] rho = new double[_k + 1];
        rho[1] = 1.0 / _k;
        for (int d = 2; d <= _k; d++) rho[d] = 1.0 / (d * (d - 1));

        double[] tau = new double[_k + 1];
        int limit = (int)Math.Floor(_k / s);
        for (int d = 1; d <= limit - 1 && d <= _k; d++) tau[d] = s / (_k * d);
        if (limit >= 1 && limit <= _k) tau[limit] = (s * Math.Log(s / delta)) / _k;

        double[] probabilities = new double[_k + 1];
        double sum = 0;
        for (int d = 1; d <= _k; d++)
        {
            probabilities[d] = rho[d] + tau[d];
            sum += probabilities[d];
        }

        double cumulative = 0;
        for (int d = 1; d <= _k; d++)
        {
            probabilities[d] /= sum;
            cumulative += probabilities[d];
            _cdf[d] = cumulative;
        }
    }

    public int SampleDegree(Mulberry32PRNG prng)
    {
        ArgumentNullException.ThrowIfNull(prng);
        double p = prng.NextDouble();
        int low = 1;
        int high = _k;
        while (low < high)
        {
            int mid = (low + high) / 2;
            if (p <= _cdf[mid]) high = mid;
            else low = mid + 1;
        }
        return low;
    }
}
