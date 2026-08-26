import {
  reactExtension,
  BlockStack,
  Button,
  Divider,
  Icon,
  Image,
  InlineLayout,
  InlineStack,
  Link,
  Text,
  View,
  useSettings,
  useShop,
  useStorage,
} from '@shopify/ui-extensions-react/checkout';
import {useEffect, useState} from 'react';

const TRUSTSCORE_BANDS = [
  {min: 4.8, key: 5, label: 'Excellent'},
  {min: 4.3, key: 4.5, label: 'Excellent'},
  {min: 3.8, key: 4, label: 'Great'},
  {min: 3.3, key: 3.5, label: 'Average'},
  {min: 2.8, key: 3, label: 'Average'},
  {min: 2.3, key: 2.5, label: 'Poor'},
  {min: 1.8, key: 2, label: 'Poor'},
  {min: 1.3, key: 1.5, label: 'Bad'},
  {min: 1, key: 1, label: 'Bad'},
];

/** Direct worker base for CORS-safe fetch from checkout extension sandbox. */
const PROXY_BASE_URL = 'https://tp-checkout-proxy.kej-194.workers.dev';

const BRANDMARK_ASPECT = 4;
/** Trustpilot strip PNGs are 512×96 (served via app proxy / worker). */
const RATING_STRIP_ASPECT = 512 / 96;
const SESSION_CACHE_PREFIX = 'tp-checkout-reviews';

/** Must match `[app_proxy].subpath` in shopify.app*.toml */
const APP_PROXY_SUBPATH = 'tp-proxy';

function TrustpilotBrandmarkFallback() {
  return (
    <InlineStack spacing="extraTight" blockAlignment="center">
      <Icon source="starFill" size="small" appearance="success" />
      <Text size="small" emphasis="bold">
        Trustpilot
      </Text>
    </InlineStack>
  );
}

function brandmarkImage(source) {
  return (
    <View minInlineSize={96} maxInlineSize={140} minBlockSize={22}>
      <Image
        source={source}
        accessibilityDescription="Trustpilot"
        aspectRatio={BRANDMARK_ASPECT}
        fit="contain"
        loading="eager"
      />
    </View>
  );
}

function trustpilotBrandmarkAppProxyUrl(myshopifyDomain) {
  const shopHost = String(myshopifyDomain ?? '').trim();
  if (!shopHost) {
    return '';
  }
  return `https://${shopHost}/apps/${APP_PROXY_SUBPATH}/img/tp/brandmark`;
}

function trustpilotBrandmarkDirectUrl() {
  return `${PROXY_BASE_URL}/img/tp/brandmark`;
}

/** Trustpilot brandmark PNG via shop app proxy (preferred) or worker. No fetch probes. */
function TrustpilotBrandmark({myshopifyDomain}) {
  const source =
    trustpilotBrandmarkAppProxyUrl(myshopifyDomain) ||
    trustpilotBrandmarkDirectUrl();
  if (!source) {
    return <TrustpilotBrandmarkFallback />;
  }
  return brandmarkImage(source);
}

function halfKeyToStripSegment(halfKey) {
  const n = Number(halfKey);
  if (!Number.isFinite(n)) {
    return '1';
  }
  const step = Math.round(n * 2);
  const bounded = Math.min(10, Math.max(2, step));
  const h = bounded / 2;
  if (h === 1.5) return '1half';
  if (h === 2.5) return '2half';
  if (h === 3.5) return '3half';
  if (h === 4.5) return '4half';
  return String(h);
}

function trustpilotStripAppProxyUrl(myshopifyDomain, halfKey) {
  const host = String(myshopifyDomain ?? '').trim();
  if (!host) {
    return '';
  }
  const k = halfKeyToStripSegment(halfKey);
  return `https://${host}/apps/${APP_PROXY_SUBPATH}/img/tp/r${k}`;
}

function trustpilotStripDirectUrl(halfKey) {
  const k = halfKeyToStripSegment(halfKey);
  return `${PROXY_BASE_URL}/img/tp/r${k}`;
}

const DISPLAY_MODES = new Set(['summary', 'list', 'carousel']);
const REVIEW_FILTERS = new Set(['five_only', 'four_and_five', 'latest']);

function trustpilotApiProxyUrl(buid, {skipReviews, filter, limit} = {}) {
  const id = String(buid ?? '').trim();
  if (!id) {
    return '';
  }
  const qs = new URLSearchParams({buid: id});
  if (skipReviews) {
    qs.set('skipReviews', '1');
  } else {
    const f = REVIEW_FILTERS.has(String(filter)) ? filter : 'four_and_five';
    const n = Number(limit);
    const lim = Number.isFinite(n) ? Math.min(10, Math.max(2, n)) : 2;
    qs.set('filter', f);
    qs.set('limit', String(lim));
  }
  return `${PROXY_BASE_URL}/api/proxy?${qs.toString()}`;
}

function normalizeDisplayMode(raw) {
  const s = String(raw ?? '').trim();
  return DISPLAY_MODES.has(s) ? s : 'list';
}

function normalizeReviewFilter(raw) {
  const s = String(raw ?? '').trim();
  return REVIEW_FILTERS.has(s) ? s : 'four_and_five';
}

function clampReviewCount(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    return 2;
  }
  return Math.min(10, Math.max(2, Math.round(n)));
}

function filterCallout(filter) {
  if (filter === 'five_only') {
    return 'Showing our 5 star reviews';
  }
  if (filter === 'latest') {
    return 'Showing our latest reviews';
  }
  return 'Showing our 4 & 5 star reviews';
}

function formatTrustScoreOneDecimal(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return '—';
  }
  return (Math.round(score * 10) / 10).toFixed(1);
}

function formatRatingForSpeech(rating) {
  const r =
    typeof rating === 'number' && !Number.isNaN(rating)
      ? Math.min(5, Math.max(0, rating))
      : 0;
  if (r === Math.floor(r)) {
    return String(Math.round(r));
  }
  return (Math.round(r * 10) / 10).toFixed(1);
}

function starRatingAccessibilityLabel(rating, totalReviews) {
  const stars = formatRatingForSpeech(rating);
  if (typeof totalReviews === 'number' && totalReviews >= 0) {
    const count = totalReviews.toLocaleString();
    return `Rated ${stars} out of 5 stars based on ${count} verified reviews`;
  }
  return `Rated ${stars} out of 5 stars`;
}

function sessionCacheKey(buid, summaryOnly, filter, limit) {
  return `${SESSION_CACHE_PREFIX}:${buid}:${summaryOnly ? 'summary' : 'reviews'}:${filter}:${limit}`;
}

function applySessionPayload(payload, domainSetting) {
  const unit = payload?.unitData;
  return {
    score: unit?.score?.trustScore ?? null,
    totalReviews: totalReviewsFromUnit(unit),
    profileUrl: trustpilotProfileUrl(unit, domainSetting),
    reviews: payload?.reviewsData?.reviews ?? [],
  };
}

/** Icon fallback when strip image URLs are unavailable. */
function AccessibleStarRatingIcons({rating, size = 'small', totalReviews}) {
  const r =
    typeof rating === 'number' && !Number.isNaN(rating)
      ? Math.min(5, Math.max(0, rating))
      : 0;
  const label = starRatingAccessibilityLabel(r, totalReviews);
  const slots = [];
  for (let i = 1; i <= 5; i++) {
    let source = 'star';
    let appearance = 'subdued';
    if (r >= i) {
      source = 'starFill';
      appearance = 'success';
    } else if (r >= i - 0.5) {
      source = 'starHalf';
      appearance = 'success';
    }
    slots.push(
      <Icon
        key={i}
        source={source}
        size={size}
        appearance={appearance}
      />,
    );
  }
  return (
    <View accessibilityLabel={label}>
      <View accessibilityVisibility="hidden">
        <InlineStack spacing="none" blockAlignment="center">
          {slots}
        </InlineStack>
      </View>
    </View>
  );
}

/**
 * Trustpilot rating strip PNG (green boxes + stars). Uses shop app-proxy Image URL
 * (checkout-safe) with worker fallback — no fetch probes. ADA label on wrapper.
 */
function TrustpilotRatingStrip({
  halfKey,
  myshopifyDomain,
  variant,
  totalReviews,
}) {
  const iconSize = variant === 'header' ? 'base' : 'small';
  const maxInline = variant === 'header' ? 260 : 160;
  const minInline = variant === 'header' ? 140 : 88;
  const minBlock = variant === 'header' ? 32 : 20;
  const r =
    typeof halfKey === 'number' && !Number.isNaN(halfKey)
      ? Math.min(5, Math.max(0, halfKey))
      : 0;
  const label = starRatingAccessibilityLabel(r, totalReviews);

  const stripSource =
    trustpilotStripAppProxyUrl(myshopifyDomain, halfKey) ||
    trustpilotStripDirectUrl(halfKey);

  if (!stripSource) {
    return (
      <AccessibleStarRatingIcons
        rating={halfKey}
        size={iconSize}
        totalReviews={totalReviews}
      />
    );
  }

  return (
    <View accessibilityLabel={label}>
      <View accessibilityVisibility="hidden">
        <View minInlineSize={minInline} maxInlineSize={maxInline} minBlockSize={minBlock}>
          <Image
            source={stripSource}
            aspectRatio={RATING_STRIP_ASPECT}
            fit="contain"
            loading="eager"
          />
        </View>
      </View>
    </View>
  );
}

function presentationForTrustScore(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) {
    return null;
  }
  const s = Math.min(5, Math.max(1, score));
  for (const band of TRUSTSCORE_BANDS) {
    if (s >= band.min) {
      return {
        label: band.label,
        rating: band.key,
      };
    }
  }
  return {
    label: 'Bad',
    rating: 1,
  };
}

function normalizeTrustpilotDomainSlug(raw) {
  let s = String(raw ?? '').trim();
  if (!s || s.toLowerCase() === 'our store') {
    return '';
  }
  s = s.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
  s = s.split('/')[0].split('?')[0].trim();
  return s;
}

function profileSlugFromUnit(unitData, domainSetting) {
  if (unitData && typeof unitData === 'object') {
    const identifying =
      unitData.name?.identifying ??
      (Array.isArray(unitData.name?.referring)
        ? unitData.name.referring[0]
        : null) ??
      '';
    const s = String(identifying).trim();
    if (s) {
      return normalizeTrustpilotDomainSlug(s) || s;
    }
  }
  return normalizeTrustpilotDomainSlug(domainSetting);
}

/** https://www.trustpilot.com/review/{slug} — slug from API or Trustpilot Domain setting. */
function trustpilotProfileUrl(unitData, domainSetting) {
  const slug = profileSlugFromUnit(unitData, domainSetting);
  if (!slug) {
    return '';
  }
  return `https://www.trustpilot.com/review/${encodeURIComponent(slug)}`;
}

function totalReviewsFromUnit(unitData) {
  if (!unitData || typeof unitData !== 'object') {
    return null;
  }
  const block = unitData.numberOfReviews;
  if (block == null) {
    return null;
  }
  if (typeof block === 'object' && block.total != null) {
    const n = Number(block.total);
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(block);
  return Number.isFinite(n) ? n : null;
}

function ratingFromReviewStars(stars) {
  const raw = Number(stars);
  if (!Number.isFinite(raw)) {
    return 1;
  }
  const clamped = Math.min(5, Math.max(1, raw));
  const halfSteps = Math.round(clamped * 2);
  const bounded = Math.min(10, Math.max(2, halfSteps));
  return bounded / 2;
}

function formatReviewDate(iso) {
  if (!iso || typeof iso !== 'string') {
    return '';
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleDateString('en-GB', {day: 'numeric', month: 'long'});
}

/** Same layout on summary, list, and carousel: even spacing across the row. */
function BasedOnReviewsRow({
  profileUrl,
  reviewsLinkLabel,
  myshopifyDomain,
}) {
  return (
    <InlineStack
      spacing="tight"
      blockAlignment="center"
      inlineAlignment="center"
    >
      <Text size="small" appearance="subdued">
        Based on
      </Text>
      {profileUrl ? (
        <Link
          to={profileUrl}
          external
          accessibilityLabel={`${reviewsLinkLabel} on Trustpilot`}
        >
          <Text size="small" emphasis="bold">
            {reviewsLinkLabel}
          </Text>
        </Link>
      ) : (
        <Text size="small" emphasis="bold">
          {reviewsLinkLabel}
        </Text>
      )}
      <Text size="small" appearance="subdued">
        on
      </Text>
      <TrustpilotBrandmark myshopifyDomain={myshopifyDomain} />
    </InlineStack>
  );
}

function TrustpilotReviewCard({review, profileUrl, myshopifyDomain, listSemantics}) {
  const rowRating = ratingFromReviewStars(review.stars);
  const displayName = review.consumer?.displayName ?? 'Verified buyer';
  const datePart = formatReviewDate(review.createdAt);
  const rawBody = String(review.text ?? '').trim();
  const rawTitle = String(review.title ?? '').trim();
  const showTitle = rawTitle.length > 0;
  const verified = Boolean(review.isVerified);
  const reviewLabel = [
    displayName,
    datePart,
    showTitle ? rawTitle : '',
    rawBody.length > 0 ? rawBody : '',
    verified ? 'Verified review' : '',
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <BlockStack
      spacing="extraTight"
      accessibilityRole={listSemantics ? 'listItem' : 'group'}
      accessibilityLabel={reviewLabel}
    >
      <InlineLayout
        spacing="tight"
        columns={['auto', 'auto']}
        blockAlignment="center"
      >
        <TrustpilotRatingStrip
          halfKey={rowRating}
          myshopifyDomain={myshopifyDomain}
          variant="row"
        />
        {verified && profileUrl ? (
          <Link
            to={profileUrl}
            external
            accessibilityLabel="Verified review on Trustpilot"
          >
            <InlineStack spacing="extraTight" blockAlignment="center">
              <Icon source="checkmark" size="extraSmall" appearance="subdued" />
              <Text size="extraSmall" appearance="subdued">
                Verified
              </Text>
            </InlineStack>
          </Link>
        ) : verified ? (
          <InlineStack spacing="extraTight" blockAlignment="center">
            <Icon source="checkmark" size="extraSmall" appearance="subdued" />
            <Text size="extraSmall" appearance="subdued">
              Verified
            </Text>
          </InlineStack>
        ) : null}
      </InlineLayout>

      <InlineStack spacing="none" blockAlignment="baseline">
        <Text size="small" emphasis="bold">
          {displayName}
        </Text>
        {datePart ? (
          <Text size="small" appearance="subdued">
            {`, ${datePart}`}
          </Text>
        ) : null}
      </InlineStack>

      {showTitle ? (
        <Text size="small" emphasis="bold">
          {rawTitle}
        </Text>
      ) : null}

      {rawBody.length > 0 ? <Text size="small">{rawBody}</Text> : null}
    </BlockStack>
  );
}

export default reactExtension('purchase.checkout.block.render', () => <App />);

function App() {
  const {myshopifyDomain} = useShop();
  const storage = useStorage();
  const {
    trustpilot_buid,
    trustpilot_domain,
    widget_display_mode,
    widget_review_count,
    widget_review_filter,
  } = useSettings();
  const [reviews, setReviews] = useState([]);
  const [score, setScore] = useState(null);
  const [totalReviews, setTotalReviews] = useState(null);
  const [profileUrl, setProfileUrl] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [fetchError, setFetchError] = useState('');
  const [carouselIndex, setCarouselIndex] = useState(0);

  const buidValue = String(trustpilot_buid ?? '').trim();
  const domainValue = String(trustpilot_domain ?? 'our store').trim();
  const displayMode = normalizeDisplayMode(widget_display_mode);
  const reviewFilter = normalizeReviewFilter(widget_review_filter);
  const reviewCount = clampReviewCount(widget_review_count);
  const summaryOnly = displayMode === 'summary';
  const showReviewBodies = displayMode === 'list' || displayMode === 'carousel';

  const overallPresentation = presentationForTrustScore(score);

  useEffect(() => {
    if (!buidValue) {
      setIsLoading(false);
      return;
    }

    let isMounted = true;

    async function fetchReviews() {
      setFetchError('');
      const cacheKey = sessionCacheKey(
        buidValue,
        summaryOnly,
        reviewFilter,
        reviewCount,
      );

      try {
        const cached = await storage.read(cacheKey);
        if (cached && typeof cached === 'object' && cached.unitData) {
          if (!isMounted) return;
          const applied = applySessionPayload(cached, domainValue);
          setScore(applied.score);
          setTotalReviews(applied.totalReviews);
          setProfileUrl(applied.profileUrl);
          setReviews(applied.reviews);
          setIsLoading(false);
          return;
        }
      } catch {
        /* proceed to network */
      }

      setIsLoading(true);

      try {
        const endpoint = trustpilotApiProxyUrl(buidValue, {
          skipReviews: summaryOnly,
          filter: reviewFilter,
          limit: reviewCount,
        });
        if (!endpoint) {
          throw new Error('Missing BUID for proxy URL.');
        }
        const response = await fetch(endpoint);

        if (!response.ok) {
          throw new Error(`${endpoint} -> ${response.status}`);
        }

        const result = await response.json();
        if (!isMounted) return;

        try {
          await storage.write(cacheKey, result);
        } catch {
          /* non-fatal */
        }

        const applied = applySessionPayload(result, domainValue);
        setScore(applied.score);
        setTotalReviews(applied.totalReviews);
        setProfileUrl(applied.profileUrl);
        setReviews(applied.reviews);
      } catch (error) {
        if (!isMounted) return;
        setFetchError(
          error instanceof Error ? error.message : 'Unable to load reviews.',
        );
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    fetchReviews();
    return () => {
      isMounted = false;
    };
  }, [
    buidValue,
    domainValue,
    summaryOnly,
    reviewFilter,
    reviewCount,
    storage,
  ]);

  useEffect(() => {
    setCarouselIndex(0);
  }, [reviews, displayMode]);

  if (!buidValue) {
    return <Text>Please set BUID in settings.</Text>;
  }

  const reviewsLinkLabel =
    typeof totalReviews === 'number' && totalReviews >= 0
      ? `${totalReviews.toLocaleString()} reviews`
      : 'reviews';

  const showBasedOnRow =
    !isLoading &&
    !fetchError &&
    (Boolean(profileUrl) ||
      (typeof totalReviews === 'number' && totalReviews >= 0));

  const ratedRow =
    displayMode === 'carousel' &&
    showReviewBodies &&
    !isLoading &&
    !fetchError &&
    typeof score === 'number' &&
    !Number.isNaN(score) ? (
      <InlineStack spacing="tight" blockAlignment="baseline" inlineAlignment="start">
        <Text size="small">
          {`Rated ${formatTrustScoreOneDecimal(score)} / 5 based on `}
        </Text>
        {profileUrl ? (
          <Link
            to={profileUrl}
            external
            accessibilityLabel={`${reviewsLinkLabel} on Trustpilot`}
          >
            <Text size="small" emphasis="bold">
              {reviewsLinkLabel}
            </Text>
          </Link>
        ) : (
          <Text size="small" emphasis="bold">
            {reviewsLinkLabel}
          </Text>
        )}
      </InlineStack>
    ) : null;

  const footerCallout =
    showReviewBodies && !isLoading && !fetchError ? (
      <Text size="extraSmall" appearance="subdued">
        {filterCallout(reviewFilter)}
      </Text>
    ) : null;

  const listBlock =
    !isLoading && !fetchError && reviews.length > 0 ? (
      <BlockStack
        spacing="loose"
        inlineAlignment="start"
        accessibilityRole="unorderedList"
        accessibilityLabel="Recent Trustpilot reviews"
      >
        {reviews.map((review) => (
          <TrustpilotReviewCard
            key={review.id}
            review={review}
            profileUrl={profileUrl}
            myshopifyDomain={myshopifyDomain}
            listSemantics
          />
        ))}
      </BlockStack>
    ) : null;

  const listSection = displayMode === 'list' ? listBlock : null;

  const carouselReview = reviews[carouselIndex];
  const carouselSection =
    displayMode === 'carousel' && !isLoading && !fetchError ? (
      <InlineLayout
        spacing="base"
        columns={['auto', 'fill', 'auto']}
        blockAlignment="center"
      >
        <Button
          kind="secondary"
          accessibilityLabel="Previous review"
          disabled={reviews.length <= 1 || carouselIndex <= 0}
          onPress={() => setCarouselIndex((i) => Math.max(0, i - 1))}
        >
          ‹
        </Button>
        <View minInlineSize="fill" maxInlineSize="100%" inlineAlignment="center">
          {carouselReview ? (
            <TrustpilotReviewCard
              review={carouselReview}
              profileUrl={profileUrl}
              myshopifyDomain={myshopifyDomain}
              listSemantics={false}
            />
          ) : (
            <Text size="small" appearance="subdued">
              No reviews to show.
            </Text>
          )}
        </View>
        <Button
          kind="secondary"
          accessibilityLabel="Next review"
          disabled={
            reviews.length <= 1 || carouselIndex >= reviews.length - 1
          }
          onPress={() =>
            setCarouselIndex((i) => Math.min(reviews.length - 1, i + 1))
          }
        >
          ›
        </Button>
      </InlineLayout>
    ) : null;

  if (summaryOnly) {
    return (
      <BlockStack spacing="loose" inlineAlignment="start">
        <BlockStack spacing="tight" inlineAlignment="center">
          {overallPresentation ? (
            <InlineLayout
              spacing="base"
              columns={['auto', 'auto']}
              blockAlignment="center"
            >
              <Text size="extraLarge" emphasis="bold">
                {overallPresentation.label}
              </Text>
              <TrustpilotRatingStrip
                halfKey={overallPresentation.rating}
                myshopifyDomain={myshopifyDomain}
                variant="header"
                totalReviews={totalReviews}
              />
            </InlineLayout>
          ) : (
            <Text size="small" appearance="subdued">
              Rating unavailable
            </Text>
          )}

          {isLoading ? (
            <Text size="small" appearance="subdued">
              Loading Trustpilot summary...
            </Text>
          ) : null}

          {!isLoading && fetchError ? (
            <Text size="small" appearance="subdued">
              Trustpilot unavailable ({fetchError}).
            </Text>
          ) : null}

          {showBasedOnRow ? (
            <BasedOnReviewsRow
              profileUrl={profileUrl}
              reviewsLinkLabel={reviewsLinkLabel}
              myshopifyDomain={myshopifyDomain}
            />
          ) : null}
        </BlockStack>
      </BlockStack>
    );
  }

  return (
    <BlockStack spacing="loose" inlineAlignment="start">
      <BlockStack spacing="tight" inlineAlignment="center">
        {overallPresentation ? (
          <InlineLayout
            spacing="base"
            columns={['auto', 'auto']}
            blockAlignment="center"
          >
            <Text size="extraLarge" emphasis="bold">
              {overallPresentation.label}
            </Text>
            <TrustpilotRatingStrip
              halfKey={overallPresentation.rating}
              myshopifyDomain={myshopifyDomain}
              variant="header"
              totalReviews={totalReviews}
            />
          </InlineLayout>
        ) : (
          <Text size="small" appearance="subdued">
            Rating unavailable
          </Text>
        )}

        {showBasedOnRow ? (
          <BasedOnReviewsRow
            profileUrl={profileUrl}
            reviewsLinkLabel={reviewsLinkLabel}
            myshopifyDomain={myshopifyDomain}
          />
        ) : null}
      </BlockStack>

      <Divider />

      {isLoading ? (
        <Text size="small" appearance="subdued">
          Loading recent reviews...
        </Text>
      ) : null}

      {!isLoading && fetchError ? (
        <Text size="small" appearance="subdued">
          Reviews unavailable right now ({fetchError}).
        </Text>
      ) : null}

      {!isLoading && !fetchError && reviews.length === 0 ? (
        <Text size="small" appearance="subdued">
          No reviews found for this display setting.
        </Text>
      ) : null}

      {listSection}
      {displayMode === 'carousel' ? carouselSection : null}

      {ratedRow}
      {footerCallout}
    </BlockStack>
  );
}
