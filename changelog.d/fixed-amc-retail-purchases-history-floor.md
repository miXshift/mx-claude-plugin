- **Amazon Retail Purchases analyses no longer stop at the date you subscribed.**
  The AMC guidance treated the retail purchase subscription date as the start of
  the data, so lifetime value, cohort and repeat purchase reads were quietly
  clamped to however long the subscription had been running. Amazon actually
  holds around five years of purchase history behind that date. On one account
  the difference was 60 months of customers instead of 13, and a new versus
  repeat read that had reported every buyer as new in its first month and
  overstated new customers by 18% a year later. The skill now measures the real
  start of the data before it sets any window, and says so when it reports.
