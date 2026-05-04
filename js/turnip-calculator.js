// ACNH Turnip Price Calculator - based on reverse-engineered game algorithm
// Reference: https://github.com/mikebryant/ac-nh-turnip-prices

const PATTERN = {
    FLUCTUATING: 0,
    LARGE_SPIKE: 1,
    DECREASING: 2,
    SMALL_SPIKE: 3,
    ALL: 4
};

const PATTERN_LABELS = {
    [PATTERN.FLUCTUATING]: 'Fluctuating',
    [PATTERN.LARGE_SPIKE]: 'Large Spike',
    [PATTERN.DECREASING]: 'Decreasing',
    [PATTERN.SMALL_SPIKE]: 'Small Spike',
    [PATTERN.ALL]: 'All Patterns'
};

const PATTERN_EXPLANATIONS = {
    [PATTERN.FLUCTUATING]: 'Prices fluctuate with alternating high and decreasing phases. No single dominant spike.',
    [PATTERN.LARGE_SPIKE]: 'Prices decrease for several days, then spike dramatically (up to 6× buy price).',
    [PATTERN.DECREASING]: 'Prices steadily decrease throughout the entire week from the buy price.',
    [PATTERN.SMALL_SPIKE]: 'Prices decrease, then have a moderate spike (up to 2× buy price), then decrease again.'
};

const PATTERN_TRANSITION_PROBS = {
    [PATTERN.FLUCTUATING]: {
        [PATTERN.FLUCTUATING]: 0.20,
        [PATTERN.LARGE_SPIKE]: 0.30,
        [PATTERN.DECREASING]: 0.15,
        [PATTERN.SMALL_SPIKE]: 0.35
    },
    [PATTERN.LARGE_SPIKE]: {
        [PATTERN.FLUCTUATING]: 0.50,
        [PATTERN.LARGE_SPIKE]: 0.05,
        [PATTERN.DECREASING]: 0.20,
        [PATTERN.SMALL_SPIKE]: 0.25
    },
    [PATTERN.DECREASING]: {
        [PATTERN.FLUCTUATING]: 0.25,
        [PATTERN.LARGE_SPIKE]: 0.45,
        [PATTERN.DECREASING]: 0.05,
        [PATTERN.SMALL_SPIKE]: 0.25
    },
    [PATTERN.SMALL_SPIKE]: {
        [PATTERN.FLUCTUATING]: 0.45,
        [PATTERN.LARGE_SPIKE]: 0.25,
        [PATTERN.DECREASING]: 0.15,
        [PATTERN.SMALL_SPIKE]: 0.15
    }
};

// Steady-state probabilities when previous pattern is unknown
const DEFAULT_TRANSITION_PROBS = [4530 / 13082, 3236 / 13082, 1931 / 13082, 3385 / 13082];

const RATE_SCALE = 10000;
const STORAGE_KEY = 'turnip-calculator-data';

// --- Utility Functions ---

function rangeSpan(range) {
    return range[1] - range[0];
}

function clamp(x, min, max) {
    return Math.min(Math.max(x, min), max);
}

function intersectRanges(range1, range2) {
    if (range1[0] > range2[1] || range1[1] < range2[0]) return null;
    return [Math.max(range1[0], range2[0]), Math.min(range1[1], range2[1])];
}

function intersectSpan(range1, range2) {
    if (range1[0] > range2[1] || range1[1] < range2[0]) return 0;
    return rangeSpan(intersectRanges(range1, range2));
}

function accurateSum(input) {
    let sum = 0, c = 0;
    for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        const t = sum + cur;
        if (Math.abs(sum) >= Math.abs(cur)) {
            c += (sum - t) + cur;
        } else {
            c += (cur - t) + sum;
        }
        sum = t;
    }
    return sum + c;
}

function prefixAccurateSums(input) {
    const prefixSum = [[0, 0]];
    let sum = 0, c = 0;
    for (let i = 0; i < input.length; i++) {
        const cur = input[i];
        const t = sum + cur;
        if (Math.abs(sum) >= Math.abs(cur)) {
            c += (sum - t) + cur;
        } else {
            c += (cur - t) + sum;
        }
        sum = t;
        prefixSum.push([sum, c]);
    }
    return prefixSum;
}

// --- PDF (Probability Density Function) Class ---

class PDF {
    constructor(a, b, uniform = true) {
        this.minVal = Math.floor(a);
        this.maxVal = Math.ceil(b);
        const range = [a, b];
        const totalLength = rangeSpan(range);
        this.prob = new Array(this.maxVal - this.minVal);
        if (uniform) {
            for (let i = 0; i < this.prob.length; i++) {
                this.prob[i] = intersectSpan(this.rangeOf(i), range) / totalLength;
            }
        }
    }

    rangeOf(idx) {
        return [this.minVal + idx, this.minVal + idx + 1];
    }

    min() {
        return this.minVal;
    }

    max() {
        return this.maxVal;
    }

    normalize() {
        const total = accurateSum(this.prob);
        for (let i = 0; i < this.prob.length; i++) {
            this.prob[i] /= total;
        }
        return total;
    }

    rangeLimit(range) {
        let [start, end] = range;
        start = Math.max(start, this.min());
        end = Math.min(end, this.max());
        if (start >= end) {
            this.minVal = this.maxVal = 0;
            this.prob = [];
            return 0;
        }
        start = Math.floor(start);
        end = Math.ceil(end);
        const startIdx = start - this.minVal;
        const endIdx = end - this.minVal;
        for (let i = startIdx; i < endIdx; i++) {
            this.prob[i] *= intersectSpan(this.rangeOf(i), [start, end]);
        }
        this.prob = this.prob.slice(startIdx, endIdx);
        this.minVal = start;
        this.maxVal = end;
        return this.normalize();
    }

    decay(rateDecayMin, rateDecayMax) {
        rateDecayMin = Math.round(rateDecayMin);
        rateDecayMax = Math.round(rateDecayMax);
        const prefix = prefixAccurateSums(this.prob);
        const maxX = this.prob.length;
        const maxY = rateDecayMax - rateDecayMin;
        const newProb = new Array(this.prob.length + maxY);
        for (let i = 0; i < newProb.length; i++) {
            const left = Math.max(0, i - maxY);
            const right = Math.min(maxX - 1, i);
            const numbersToSum = [
                prefix[right + 1][0], prefix[right + 1][1],
                -prefix[left][0], -prefix[left][1]
            ];
            if (left === i - maxY) {
                numbersToSum.push(-this.prob[left] / 2);
            }
            if (right === i) {
                numbersToSum.push(-this.prob[right] / 2);
            }
            newProb[i] = accurateSum(numbersToSum) / maxY;
        }
        this.prob = newProb;
        this.minVal -= rateDecayMax;
        this.maxVal -= rateDecayMin;
    }
}

// --- Predictor Class ---

class Predictor {
    constructor(prices, firstBuy, previousPattern) {
        this.tolerance = 0;
        this.prices = prices;
        this.firstBuy = firstBuy;
        this.previousPattern = previousPattern;
    }

    ceilInt(val) {
        return Math.trunc(val + 0.99999);
    }

    minRateForPrice(givenPrice, buyPrice) {
        return RATE_SCALE * (givenPrice - 0.99999) / buyPrice;
    }

    maxRateForPrice(givenPrice, buyPrice) {
        return RATE_SCALE * (givenPrice + 0.00001) / buyPrice;
    }

    rateRangeForPrice(givenPrice, buyPrice) {
        return [this.minRateForPrice(givenPrice, buyPrice),
            this.maxRateForPrice(givenPrice, buyPrice)];
    }

    getPrice(rate, basePrice) {
        return this.ceilInt(rate * basePrice / RATE_SCALE);
    }

    * multiplyGeneratorProbability(generator, probability) {
        for (const it of generator) {
            yield {...it, probability: it.probability * probability};
        }
    }

    generateRandomPrice(givenPrices, predictedPrices, start, length, rateMin, rateMax) {
        rateMin *= RATE_SCALE;
        rateMax *= RATE_SCALE;
        const buyPrice = givenPrices[0];
        const rateRange = [rateMin, rateMax];
        let prob = 1;

        for (let i = start; i < start + length; i++) {
            let minPred = this.getPrice(rateMin, buyPrice);
            let maxPred = this.getPrice(rateMax, buyPrice);
            if (!isNaN(givenPrices[i])) {
                if (givenPrices[i] < minPred - this.tolerance || givenPrices[i] > maxPred + this.tolerance) {
                    return 0;
                }
                const realRateRange = this.rateRangeForPrice(
                    clamp(givenPrices[i], minPred, maxPred), buyPrice);
                prob *= intersectSpan(rateRange, realRateRange) / rangeSpan(rateRange);
                minPred = givenPrices[i];
                maxPred = givenPrices[i];
            }
            predictedPrices.push({min: minPred, max: maxPred});
        }
        return prob;
    }

    generateDecayingPrice(givenPrices, predictedPrices, start, length,
                          startRateMin, startRateMax, rateDecayMin, rateDecayMax) {
        startRateMin *= RATE_SCALE;
        startRateMax *= RATE_SCALE;
        rateDecayMin *= RATE_SCALE;
        rateDecayMax *= RATE_SCALE;
        const buyPrice = givenPrices[0];
        let ratePdf = new PDF(startRateMin, startRateMax);
        let prob = 1;

        for (let i = start; i < start + length; i++) {
            let minPred = this.getPrice(ratePdf.min(), buyPrice);
            let maxPred = this.getPrice(ratePdf.max(), buyPrice);
            if (!isNaN(givenPrices[i])) {
                if (givenPrices[i] < minPred - this.tolerance || givenPrices[i] > maxPred + this.tolerance) {
                    return 0;
                }
                const realRateRange = this.rateRangeForPrice(
                    clamp(givenPrices[i], minPred, maxPred), buyPrice);
                prob *= ratePdf.rangeLimit(realRateRange);
                if (prob === 0) return 0;
                minPred = givenPrices[i];
                maxPred = givenPrices[i];
            }
            predictedPrices.push({min: minPred, max: maxPred});
            ratePdf.decay(rateDecayMin, rateDecayMax);
        }
        return prob;
    }

    generatePeakPattern(givenPrices, predictedPrices, start, rateMin, rateMax) {
        rateMin *= RATE_SCALE;
        rateMax *= RATE_SCALE;
        const buyPrice = givenPrices[0];
        let prob = 1;
        let rateRange = [rateMin, rateMax];

        const middlePrice = givenPrices[start + 1];
        if (!isNaN(middlePrice)) {
            const minPred = this.getPrice(rateMin, buyPrice);
            const maxPred = this.getPrice(rateMax, buyPrice);
            if (middlePrice < minPred - this.tolerance || middlePrice > maxPred + this.tolerance) {
                return 0;
            }
            const realRateRange = this.rateRangeForPrice(
                clamp(middlePrice, minPred, maxPred), buyPrice);
            prob *= intersectSpan(rateRange, realRateRange) / rangeSpan(rateRange);
            if (prob === 0) return 0;
            rateRange = intersectRanges(rateRange, realRateRange);
        }

        const leftPrice = givenPrices[start];
        const rightPrice = givenPrices[start + 2];
        for (const price of [leftPrice, rightPrice]) {
            if (isNaN(price)) continue;
            const minPred = this.getPrice(rateMin, buyPrice) - 1;
            const maxPred = this.getPrice(rateRange[1], buyPrice) - 1;
            if (price < minPred - this.tolerance || price > maxPred + this.tolerance) {
                return 0;
            }
            const rate2Range = this.rateRangeForPrice(
                clamp(price, minPred, maxPred) + 1, buyPrice);
            const F = (t, ZZ) => {
                if (t <= 0) return 0;
                return ZZ < t ? ZZ : t - t * (Math.log(t) - Math.log(ZZ));
            };
            const [A, B] = rateRange;
            const C = rateMin;
            const Z1 = A - C;
            const Z2 = B - C;
            const PY = (t) => (F(t - C, Z2) - F(t - C, Z1)) / (Z2 - Z1);
            prob *= PY(rate2Range[1]) - PY(rate2Range[0]);
            if (prob === 0) return 0;
        }

        let minPred = this.getPrice(rateMin, buyPrice) - 1;
        let maxPred = this.getPrice(rateMax, buyPrice) - 1;
        if (!isNaN(givenPrices[start])) {
            minPred = givenPrices[start];
            maxPred = givenPrices[start];
        }
        predictedPrices.push({min: minPred, max: maxPred});

        minPred = predictedPrices[start].min;
        maxPred = this.getPrice(rateMax, buyPrice);
        if (!isNaN(givenPrices[start + 1])) {
            minPred = givenPrices[start + 1];
            maxPred = givenPrices[start + 1];
        }
        predictedPrices.push({min: minPred, max: maxPred});

        minPred = this.getPrice(rateMin, buyPrice) - 1;
        maxPred = predictedPrices[start + 1].max - 1;
        if (!isNaN(givenPrices[start + 2])) {
            minPred = givenPrices[start + 2];
            maxPred = givenPrices[start + 2];
        }
        predictedPrices.push({min: minPred, max: maxPred});

        return prob;
    }

    * generateFluctuatingPatternWithLengths(givenPrices, hiPhaseLen1, decPhaseLen1, hiPhaseLen2, decPhaseLen2) {
        const buyPrice = givenPrices[0];
        const predictedPrices = [
            {min: buyPrice, max: buyPrice},
            {min: buyPrice, max: buyPrice}
        ];
        let probability = 1;

        probability *= this.generateRandomPrice(givenPrices, predictedPrices, 2, hiPhaseLen1, 0.9, 1.4);
        if (probability === 0) return;

        probability *= this.generateDecayingPrice(givenPrices, predictedPrices,
            2 + hiPhaseLen1, decPhaseLen1, 0.6, 0.8, 0.04, 0.1);
        if (probability === 0) return;

        probability *= this.generateRandomPrice(givenPrices, predictedPrices,
            2 + hiPhaseLen1 + decPhaseLen1, hiPhaseLen2, 0.9, 1.4);
        if (probability === 0) return;

        probability *= this.generateDecayingPrice(givenPrices, predictedPrices,
            2 + hiPhaseLen1 + decPhaseLen1 + hiPhaseLen2, decPhaseLen2, 0.6, 0.8, 0.04, 0.1);
        if (probability === 0) return;

        const prevLength = 2 + hiPhaseLen1 + decPhaseLen1 + hiPhaseLen2 + decPhaseLen2;
        probability *= this.generateRandomPrice(givenPrices, predictedPrices,
            prevLength, 14 - prevLength, 0.9, 1.4);
        if (probability === 0) return;

        yield {patternType: PATTERN.FLUCTUATING, prices: predictedPrices, probability};
    }

    * generateFluctuatingPattern(givenPrices) {
        for (let decPhaseLen1 = 2; decPhaseLen1 < 4; decPhaseLen1++) {
            for (let hiPhaseLen1 = 0; hiPhaseLen1 < 7; hiPhaseLen1++) {
                for (let hiPhaseLen3 = 0; hiPhaseLen3 < (7 - hiPhaseLen1); hiPhaseLen3++) {
                    yield* this.multiplyGeneratorProbability(
                        this.generateFluctuatingPatternWithLengths(givenPrices, hiPhaseLen1, decPhaseLen1,
                            7 - hiPhaseLen1 - hiPhaseLen3, 5 - decPhaseLen1),
                        1 / 2 / 7 / (7 - hiPhaseLen1));
                }
            }
        }
    }

    * generateLargeSpikePatternWithPeak(givenPrices, peakStart) {
        const buyPrice = givenPrices[0];
        const predictedPrices = [
            {min: buyPrice, max: buyPrice},
            {min: buyPrice, max: buyPrice}
        ];
        let probability = 1;

        probability *= this.generateDecayingPrice(givenPrices, predictedPrices,
            2, peakStart - 2, 0.85, 0.9, 0.03, 0.05);
        if (probability === 0) return;

        const minRandoms = [0.9, 1.4, 2.0, 1.4, 0.9, 0.4, 0.4, 0.4, 0.4, 0.4, 0.4];
        const maxRandoms = [1.4, 2.0, 6.0, 2.0, 1.4, 0.9, 0.9, 0.9, 0.9, 0.9, 0.9];
        for (let i = peakStart; i < 14; i++) {
            probability *= this.generateRandomPrice(givenPrices, predictedPrices,
                i, 1, minRandoms[i - peakStart], maxRandoms[i - peakStart]);
            if (probability === 0) return;
        }
        yield {patternType: PATTERN.LARGE_SPIKE, prices: predictedPrices, probability};
    }

    * generateLargeSpikePattern(givenPrices) {
        for (let peakStart = 3; peakStart < 10; peakStart++) {
            yield* this.multiplyGeneratorProbability(
                this.generateLargeSpikePatternWithPeak(givenPrices, peakStart), 1 / 7);
        }
    }

    * generateDecreasingPattern(givenPrices) {
        const buyPrice = givenPrices[0];
        const predictedPrices = [
            {min: buyPrice, max: buyPrice},
            {min: buyPrice, max: buyPrice}
        ];
        let probability = 1;

        probability *= this.generateDecayingPrice(givenPrices, predictedPrices,
            2, 12, 0.85, 0.9, 0.03, 0.05);
        if (probability === 0) return;

        yield {patternType: PATTERN.DECREASING, prices: predictedPrices, probability};
    }

    * generateSmallSpikePatternWithPeak(givenPrices, peakStart) {
        const buyPrice = givenPrices[0];
        const predictedPrices = [
            {min: buyPrice, max: buyPrice},
            {min: buyPrice, max: buyPrice}
        ];
        let probability = 1;

        probability *= this.generateDecayingPrice(givenPrices, predictedPrices,
            2, peakStart - 2, 0.4, 0.9, 0.03, 0.05);
        if (probability === 0) return;

        probability *= this.generateRandomPrice(givenPrices, predictedPrices,
            peakStart, 2, 0.9, 1.4);
        if (probability === 0) return;

        probability *= this.generatePeakPattern(givenPrices, predictedPrices,
            peakStart + 2, 1.4, 2.0);
        if (probability === 0) return;

        if (peakStart + 5 < 14) {
            probability *= this.generateDecayingPrice(givenPrices, predictedPrices,
                peakStart + 5, 14 - (peakStart + 5), 0.4, 0.9, 0.03, 0.05);
            if (probability === 0) return;
        }

        yield {patternType: PATTERN.SMALL_SPIKE, prices: predictedPrices, probability};
    }

    * generateSmallSpikePattern(givenPrices) {
        for (let peakStart = 2; peakStart < 10; peakStart++) {
            yield* this.multiplyGeneratorProbability(
                this.generateSmallSpikePatternWithPeak(givenPrices, peakStart), 1 / 8);
        }
    }

    getPatternTransitionProbs(previousPattern) {
        if (previousPattern === undefined || previousPattern === null ||
            Number.isNaN(previousPattern) || previousPattern < PATTERN.FLUCTUATING || previousPattern > PATTERN.SMALL_SPIKE) {
            return DEFAULT_TRANSITION_PROBS;
        }
        return [
            PATTERN_TRANSITION_PROBS[previousPattern][PATTERN.FLUCTUATING],
            PATTERN_TRANSITION_PROBS[previousPattern][PATTERN.LARGE_SPIKE],
            PATTERN_TRANSITION_PROBS[previousPattern][PATTERN.DECREASING],
            PATTERN_TRANSITION_PROBS[previousPattern][PATTERN.SMALL_SPIKE]
        ];
    }

    * generateAllPatterns(sellPrices, previousPattern) {
        const patternFns = [
            this.generateFluctuatingPattern.bind(this),
            this.generateLargeSpikePattern.bind(this),
            this.generateDecreasingPattern.bind(this),
            this.generateSmallSpikePattern.bind(this)
        ];
        const transitionProb = this.getPatternTransitionProbs(previousPattern);

        for (let i = PATTERN.FLUCTUATING; i <= PATTERN.SMALL_SPIKE; i++) {
            yield* this.multiplyGeneratorProbability(
                patternFns[i](sellPrices), transitionProb[i]);
        }
    }

    * generatePossibilities(sellPrices, firstBuy, previousPattern) {
        if (firstBuy || isNaN(sellPrices[0])) {
            for (let buyPrice = 90; buyPrice <= 110; buyPrice++) {
                const tempSellPrices = sellPrices.slice();
                tempSellPrices[0] = tempSellPrices[1] = buyPrice;
                if (firstBuy) {
                    yield* this.generateSmallSpikePattern(tempSellPrices);
                } else {
                    yield* this.generateAllPatterns(tempSellPrices, previousPattern);
                }
            }
        } else {
            yield* this.generateAllPatterns(sellPrices, previousPattern);
        }
    }

    analyzePossibilities() {
        const sellPrices = this.prices;
        const firstBuy = this.firstBuy;
        const previousPattern = this.previousPattern;
        let generatedPossibilities = [];

        for (let i = 0; i < 6; i++) {
            this.tolerance = i;
            generatedPossibilities = Array.from(
                this.generatePossibilities(sellPrices, firstBuy, previousPattern));
            if (generatedPossibilities.length > 0) break;
        }

        if (generatedPossibilities.length === 0) return null;

        const totalProbability = generatedPossibilities.reduce(
            (acc, it) => acc + it.probability, 0);
        for (const it of generatedPossibilities) {
            it.probability /= totalProbability;
        }

        for (let poss of generatedPossibilities) {
            let weekMins = [], weekMaxes = [];
            for (let day of poss.prices.slice(2)) {
                if (day.min !== day.max) {
                    weekMins.push(day.min);
                    weekMaxes.push(day.max);
                } else {
                    weekMins = [];
                    weekMaxes = [];
                }
            }
            if (!weekMins.length && !weekMaxes.length) {
                weekMins.push(poss.prices[poss.prices.length - 1].min);
                weekMaxes.push(poss.prices[poss.prices.length - 1].max);
            }
            poss.guaranteedMin = Math.max(...weekMins);
            poss.maxPossible = Math.max(...weekMaxes);
        }

        const categoryTotals = {};
        for (let i = PATTERN.FLUCTUATING; i <= PATTERN.SMALL_SPIKE; i++) {
            categoryTotals[i] = generatedPossibilities
                .filter(v => v.patternType === i)
                .map(v => v.probability)
                .reduce((a, b) => a + b, 0);
        }

        for (let pos of generatedPossibilities) {
            pos.categoryProbability = categoryTotals[pos.patternType];
        }

        generatedPossibilities.sort((a, b) =>
            b.categoryProbability - a.categoryProbability ||
            b.probability - a.probability);

        const globalMinMax = [];
        for (let day = 0; day < 14; day++) {
            const prices = {min: 999, max: 0};
            for (let poss of generatedPossibilities) {
                if (poss.prices[day].min < prices.min) prices.min = poss.prices[day].min;
                if (poss.prices[day].max > prices.max) prices.max = poss.prices[day].max;
            }
            globalMinMax.push(prices);
        }

        generatedPossibilities.unshift({
            patternType: PATTERN.ALL,
            prices: globalMinMax,
            guaranteedMin: Math.min(...generatedPossibilities.map(p => p.guaranteedMin)),
            maxPossible: Math.max(...generatedPossibilities.map(p => p.maxPossible))
        });

        return generatedPossibilities;
    }
}

// --- UI Functions ---

function loadData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
        try {
            const data = JSON.parse(saved);
            if (data.buyPrice) document.getElementById('buy-price').value = data.buyPrice;
            if (data.firstBuy !== undefined) {
                document.getElementById('first-buy-' + (data.firstBuy ? 'yes' : 'no')).checked = true;
            }
            if (data.previousPattern !== undefined) {
                const sel = document.getElementById('previous-pattern');
                if (sel) sel.value = data.previousPattern;
            }
            for (let i = 2; i < 14; i++) {
                const input = document.getElementById(`sell-${i}`);
                if (input && data[`sell-${i}`]) input.value = data[`sell-${i}`];
            }
        } catch (e) {
            console.error('Failed to load saved data:', e);
        }
    }
}

function saveData() {
    const data = {};
    data.buyPrice = document.getElementById('buy-price').value;
    data.firstBuy = document.getElementById('first-buy-yes').checked;
    data.previousPattern = document.getElementById('previous-pattern').value;
    for (let i = 2; i < 14; i++) {
        const input = document.getElementById(`sell-${i}`);
        if (input && input.value) data[`sell-${i}`] = input.value;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getPriceClass(buyPrice, price) {
    const brackets = [200, 30, 0, -30, -99];
    const diff = price - buyPrice;
    for (let i = 0; i < brackets.length; i++) {
        if (diff >= brackets[i]) return 'range' + i;
    }
    return '';
}

function displayPercentage(fraction) {
    if (!Number.isFinite(fraction)) return '—';
    let percent = fraction * 100;
    if (percent >= 1) return percent.toPrecision(3) + '%';
    if (percent >= 0.01) return percent.toFixed(2) + '%';
    return '<0.01%';
}

function getCurrentSlotIndex() {
    const now = new Date();
    const day = now.getDay();
    const isPM = now.getHours() >= 12;
    if (day === 0) return 1; // Sunday buy
    return day * 2 + (isPM ? 1 : 0);
}

function calculatePrices() {
    saveData();

    const buyPrice = parseInt(document.getElementById('buy-price').value || '');
    const firstBuy = document.getElementById('first-buy-yes').checked;
    const prevPatternSel = document.getElementById('previous-pattern');
    const previousPattern = prevPatternSel.value === '-1' ? -1 : parseInt(prevPatternSel.value);

    const sellInputs = [];
    for (let i = 2; i < 14; i++) {
        sellInputs.push(parseInt(document.getElementById(`sell-${i}`).value || ''));
    }

    const prices = [buyPrice, buyPrice, ...sellInputs];

    if (sellInputs.every(v => isNaN(v)) && isNaN(buyPrice)) {
        document.getElementById('results').classList.remove('visible');
        return;
    }

    const predictor = new Predictor(prices, firstBuy, previousPattern);
    const results = predictor.analyzePossibilities();

    const resultsDiv = document.getElementById('results');
    const patternResultsDiv = document.getElementById('pattern-results');

    if (!results) {
        resultsDiv.classList.add('visible');
        patternResultsDiv.innerHTML = `
      <div class="pattern-match impossible">
        <p class="pattern-name">No matching patterns found</p>
        <p>Double-check your prices. If you're sure they're correct, you may have encountered a rare edge case.</p>
      </div>`;
        document.getElementById('price-table-container').innerHTML = '';
        return;
    }

    resultsDiv.classList.add('visible');
    getCurrentSlotIndex();
    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

    let html = '';

    for (const poss of results) {
        const patNum = poss.patternType;
        const isAll = patNum === PATTERN.ALL;
        const matchClass = isAll ? 'likely' : (poss.categoryProbability > 0.3 ? 'likely' : 'possible');

        html += `<div class="pattern-match ${matchClass}">`;
        html += `<p class="pattern-name">${PATTERN_LABELS[patNum]}`;
        if (!isAll) html += ` <span class="probability-badge">${displayPercentage(poss.categoryProbability)}</span>`;
        html += `</p>`;

        if (!isAll) {
            html += `<p>${PATTERN_EXPLANATIONS[patNum]}</p>`;
            html += `<p><strong>Sub-pattern probability:</strong> ${displayPercentage(poss.probability)}</p>`;
        }

        html += `<div class="pattern-details">`;
        html += `<table class="price-table"><tr><th>Day</th>`;
        for (let d = 0; d < 6; d++) {
            html += `<th>${DAY_LABELS[d]} AM</th><th>${DAY_LABELS[d]} PM</th>`;
        }
        html += `<th>Guaranteed Min</th><th>Max Possible</th></tr><tr>`;
        html += `<td class="pattern-label">${PATTERN_LABELS[patNum]}</td>`;

        for (let i = 0; i < 12; i++) {
            const day = poss.prices[i + 2];
            const cls = getPriceClass(buyPrice || poss.prices[0].min, day.max);
            if (day.min !== day.max) {
                html += `<td class="${cls}">${day.min}–${day.max}</td>`;
            } else {
                html += `<td class="${cls}">${day.min}</td>`;
            }
        }

        const minCls = getPriceClass(buyPrice || poss.prices[0].min, poss.guaranteedMin);
        const maxCls = getPriceClass(buyPrice || poss.prices[0].min, poss.maxPossible);
        html += `<td class="${minCls}"><strong>${poss.guaranteedMin}</strong></td>`;
        html += `<td class="${maxCls}"><strong>${poss.maxPossible}</strong></td>`;
        html += `</tr></table></div></div>`;
    }

    patternResultsDiv.innerHTML = html;
    drawGraph(results, buyPrice);
}

function drawGraph(results, buyPrice) {
    const canvas = document.getElementById('priceGraph');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);

    const margin = {top: 40, right: 40, bottom: 60, left: 60};
    const graphW = width - margin.left - margin.right;
    const graphH = height - margin.top - margin.bottom;

    // Compute global min/max prices across ALL patterns for each slot
    const slotPriceRanges = [];
    for (let slot = 2; slot < 14; slot++) {
        let globalMin = Infinity, globalMax = -Infinity;
        for (const poss of results) {
            if (poss.prices[slot]) {
                globalMin = Math.min(globalMin, poss.prices[slot].min);
                globalMax = Math.max(globalMax, poss.prices[slot].max);
            }
        }
        slotPriceRanges.push({min: globalMin, max: globalMax});
    }

    let allPrices = [];
    if (!isNaN(buyPrice)) allPrices.push(buyPrice);
    for (const sp of slotPriceRanges) {
        allPrices.push(sp.min, sp.max);
    }
    if (allPrices.length === 0) allPrices = [90, 110];
    let minP = Math.min(...allPrices) - 20;
    let maxP = Math.max(...allPrices) + 20;
    minP = Math.max(0, minP);

    const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const TIME_LABELS = ['AM', 'PM'];

    function getX(slotIdx) {
        return margin.left + (graphW / 11) * slotIdx;
    }

    function getY(price) {
        return margin.top + graphH - (graphH * (price - minP) / (maxP - minP));
    }

    // Title
    ctx.fillStyle = '#333';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Turnip Prices (Bells)', width / 2, 25);

    // Y-axis grid and labels
    ctx.strokeStyle = '#e0e0e0';
    ctx.lineWidth = 1;
    const priceSteps = 7;
    for (let i = 0; i <= priceSteps; i++) {
        const price = minP + (maxP - minP) * (i / priceSteps);
        const y = getY(price);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + graphW, y);
        ctx.stroke();
        ctx.fillStyle = '#666';
        ctx.font = '12px sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText(Math.round(price), margin.left - 10, y + 4);
    }

    // X-axis labels and grid for each slot
    for (let s = 0; s < 12; s++) {
        const x = getX(s);
        const day = DAY_LABELS[Math.floor(s / 2)];
        const time = TIME_LABELS[s % 2];
        ctx.fillStyle = '#333';
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`${day} ${time}`, x, height - margin.bottom + 18);
        ctx.strokeStyle = '#e0e0e0';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, margin.top);
        ctx.lineTo(x, margin.top + graphH);
        ctx.stroke();
    }

    // Draw price range band across all patterns
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = '#555';
    ctx.beginPath();
    // Top edge (max prices)
    for (let s = 0; s < slotPriceRanges.length; s++) {
        const x = getX(s);
        const y = getY(slotPriceRanges[s].max);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    // Bottom edge (min prices) in reverse
    for (let s = slotPriceRanges.length - 1; s >= 0; s--) {
        const x = getX(s);
        const y = getY(slotPriceRanges[s].min);
        ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;

    // Draw exact prices (where min == max) and range boundaries
    for (let s = 0; s < slotPriceRanges.length; s++) {
        const x = getX(s);
        const sp = slotPriceRanges[s];
        const isExact = sp.min === sp.max;

        if (isExact) {
            // Draw exact price as a filled circle
            const y = getY(sp.min);
            ctx.fillStyle = '#222';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();
            // Label
            ctx.fillStyle = '#222';
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(sp.min, x, y - 10);
        } else {
            // Draw range endpoints
            const yMin = getY(sp.min);
            const yMax = getY(sp.max);

            // Vertical line connecting min and max
            ctx.strokeStyle = '#888';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 3]);
            ctx.beginPath();
            ctx.moveTo(x, yMin);
            ctx.lineTo(x, yMax);
            ctx.stroke();
            ctx.setLineDash([]);

            // End caps
            ctx.strokeStyle = '#555';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x - 6, yMax);
            ctx.lineTo(x + 6, yMax);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(x - 6, yMin);
            ctx.lineTo(x + 6, yMin);
            ctx.stroke();

            // Labels
            ctx.fillStyle = '#555';
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(sp.max, x, yMax - 8);
            ctx.fillText(sp.min, x, yMin + 14);
        }
    }

    // Connect min prices with a line
    ctx.strokeStyle = '#4a8c3f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let s = 0; s < slotPriceRanges.length; s++) {
        const x = getX(s);
        const y = getY(slotPriceRanges[s].min);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Connect max prices with a line
    ctx.strokeStyle = '#dc3545';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let s = 0; s < slotPriceRanges.length; s++) {
        const x = getX(s);
        const y = getY(slotPriceRanges[s].max);
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Buy price line
    if (!isNaN(buyPrice)) {
        const y = getY(buyPrice);
        ctx.strokeStyle = '#8b6914';
        ctx.lineWidth = 2;
        ctx.setLineDash([10, 5]);
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + graphW, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#8b6914';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(`Buy: ${buyPrice}`, margin.left + 5, y - 5);
    }

    // Legend for min/max lines
    const legendX = margin.left + 10;
    const legendY = margin.top + 15;
    ctx.font = '11px sans-serif';

    ctx.strokeStyle = '#4a8c3f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY);
    ctx.lineTo(legendX + 20, legendY);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.textAlign = 'left';
    ctx.fillText('Minimum across all patterns', legendX + 25, legendY + 4);

    ctx.strokeStyle = '#dc3545';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(legendX, legendY + 18);
    ctx.lineTo(legendX + 20, legendY + 18);
    ctx.stroke();
    ctx.fillStyle = '#333';
    ctx.fillText('Maximum across all patterns', legendX + 25, legendY + 22);
}

function resetForm() {
    localStorage.removeItem(STORAGE_KEY);
    document.getElementById('buy-price').value = '';
    document.getElementById('first-buy-no').checked = true;
    document.getElementById('previous-pattern').value = '-1';
    for (let i = 2; i < 14; i++) {
        const input = document.getElementById(`sell-${i}`);
        if (input) input.value = '';
    }
    document.getElementById('results').classList.remove('visible');
    document.getElementById('pattern-results').innerHTML = '';
    const canvas = document.getElementById('priceGraph');
    if (canvas) {
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
}

document.addEventListener('DOMContentLoaded', function () {
    loadData();
    const inputs = document.querySelectorAll('input[type="number"], input[type="radio"], select');
    inputs.forEach(input => {
        input.addEventListener('change', saveData);
    });

    document.querySelectorAll('input[type="number"]').forEach(input => {
        input.addEventListener('wheel', function (e) {
            e.preventDefault();
        }, { passive: false });
    });
});
