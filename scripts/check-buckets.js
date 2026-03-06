const { getPlans, getBuckets } = require('../dist/m365.js');

(async () => {
  const plans = await getPlans();
  const adPlan = plans.find(p => p.title.toLowerCase().includes('ad creative'));
  if (!adPlan) {
    console.log('No ad creative plan found');
    return;
  }
  console.log('Plan:', adPlan.title, adPlan.id);
  const buckets = await getBuckets(adPlan.id);
  console.log('\nBuckets (API order):');
  buckets.forEach((b, i) => console.log(`  ${i+1}. ${b.name} | id: ${b.id} | orderHint: ${JSON.stringify(b.orderHint)}`));
})();
