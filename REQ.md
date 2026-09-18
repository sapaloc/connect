## 1. Authentication and access control

- [ ]  Sign-in, sign-out, invitation acceptance, and password reset
- [ ]  Secure session management and rate limiting
- [ ]  Explicit selection of active role and scope—never infer the highest privilege
- [ ]  Role-based permissions for:
    - Platform Admin
    - Tenant Admin
    - Number160 Manager
    - Number160 Staff
    - Partner Admin
    - Referrer
- [ ]  Intentionally entered, visibly bannered, audited Platform Admin support access
- [ ]  English and Vietnamese interfaces
- [ ]  Complete audit attribution to the authenticated user

## 2. Internal Console

- [ ]  Attention-led operational home and approval queues
- [ ]  Basic search and practical filters
- [ ]  Partner onboarding and approval
- [ ]  Affiliated Referrer approval and rejection
- [ ]  Referral-media and NFC Card management
- [ ]  Commercial budget configuration
- [ ]  Transaction review and eligible Redemption voiding
- [ ]  Payout-profile verification and Settlement recording
- [ ]  Microsite content management and publication
- [ ]  Tenant-wide reports and CSV export

## 3. Partner management

- [ ]  Create **Company Referrers**
- [ ]  Create **independent Individual Referrers**
- [ ]  Start new Partners in `Onboarding`
- [ ]  Assign the responsible SAPAWOO Spa user
- [ ]  Capture required Company fields:
    - Company name
    - Partner type
    - Responsible internal user
- [ ]  Require contact name and either email or telephone before activation
- [ ]  Capture required Individual fields:
    - Name
    - Referrer type
    - Affiliation mode
    - Responsible internal user
- [ ]  Support optional email, telephone, position, and internal note
- [ ]  Internal approval with approver and timestamp
- [ ]  Partner Relationship validity dates
- [ ]  Partner lifecycle states, including Active, Paused, Resumed, and Ended
- [ ]  Automatic end-date processing
- [ ]  Preserve historical data when a Partner ends
- [ ]  Keep Partner lifecycle separate from Referral Media status
- [ ]  Implement a connected **Partner dossier** covering relationship, money, people, media, results, and history

## 4. Company locations

- [ ]  Create one or more physical Partner Locations
- [ ]  Store location name, street address, and district/ward
- [ ]  Treat Vietnam/Saigon as fixed V1 context
- [ ]  Optionally assign an affiliated Referrer to one current location
- [ ]  Validate that the location belongs to the selected Company
- [ ]  Require a location before activating location-based Partner types
- [ ]  Keep positions such as “Concierge” separate from physical locations

## 5. Affiliated Referrer management

- [ ]  Partner Admin can submit affiliated Referrers through MyConnect
- [ ]  New submissions enter `Pending Approval`
- [ ]  Prevent Referral generation before SAPAWOO approval
- [ ]  Inherit the responsible internal user from the Company
- [ ]  Require a Partner-facing reason when rejecting a submission
- [ ]  Support an optional internal-only rejection note
- [ ]  Partner Admin can end an affiliation without deleting it
- [ ]  Stop personal Referral Media when the affiliation ends
- [ ]  Preserve historical activity and open financial obligations
- [ ]  Keep unpaid obligations open after affiliation or Company Relationship end
- [ ]  Provide read-only MyConnect access while an ended Referrer remains owed money
- [ ]  End read-only access after the final outstanding amount is recorded as Paid

## 6. Commercial allocation

- [ ]  Tenant Admin assigns a Total Budget
- [ ]  Company allocation:
    - Customer Discount + Company Commission = Total Budget
- [ ]  Company Commission allocation:
    - Individual Share + Company Net Commission = Company Commission
- [ ]  Independent Referrer allocation:
    - Customer Discount + Individual Commission = Total Budget
- [ ]  Enforce a minimum 5% Customer Discount
- [ ]  Require full allocation with no unallocated remainder
- [ ]  Apply one uniform Individual Share to all affiliated Referrers
- [ ]  Prevent individual allocation overrides
- [ ]  Record allocation versions, actor, and timestamp
- [ ]  Apply allocation changes only to future Voucher activations

## 7. Referral Links and Referral Media

- [ ]  Generate persistent Company Referral Links and QR codes
- [ ]  Generate Location QR codes only for real, existing locations
- [ ]  Automatically generate a personal digital QR for each approved Referrer
- [ ]  Support independent Referrer QR/NFC attribution
- [ ]  Distinguish attribution by:
    - Company
    - Location
    - Affiliated Individual
    - Independent Individual
    - Referral Medium
- [ ]  Give every Referral Medium a separate revocable identifier
- [ ]  Keep personal digital QR separate from the physical NFC/QR Card
- [ ]  Stop new Referrals when the related Partner, affiliation, or medium is inactive
- [ ]  Preserve historical attribution after blocking or replacement

## 8. NFC/printed-QR Card workflow

- [ ]  Allow eligible Partner Admins and Referrers to request Cards
- [ ]  Require SAPAWOO Spa approval
- [ ]  Support the approved lifecycle:
    - Requested
    - Approved
    - In production
    - Delivered / Active
    - Rejected
    - Blocked
    - Replaced
- [ ]  Keep approval and movement to production as separate transitions
- [ ]  Record requester, approver, dates, and status history
- [ ]  Support funding classifications:
    - Free standard Card
    - Free technical-defect replacement
    - Chargeable loss/damage replacement
    - Chargeable additional Card
- [ ]  Do not implement an amount or billing workflow without a separate decision
- [ ]  Block a Card when its Referrer ends
- [ ]  Keep the separate personal digital QR active unless independently blocked
- [ ]  Show Partner users an understandable status, reason, date, and next action
- [ ]  Keep shipping, courier, inventory, and delivery-address management outside V1

## 9. Number160 customer Microsite

- [ ]  Connect-served, Number160-branded responsive Microsite
- [ ]  Present Partner context as an exclusive customer benefit
- [ ]  Show the Company/Location name where appropriate
- [ ]  Do not expose an affiliated employee’s name to the customer
- [ ]  Support an optional Partner logo with Tenant approval
- [ ]  Present approximately 4–6 highlighted services with:
    - Image
    - Benefit
    - Duration
    - Regular price
    - Discounted price or VND saving
- [ ]  Provide progressive access to all services and prices
- [ ]  Show trust signals and Number160 location information
- [ ]  Support optional Zalo and WhatsApp contact actions
- [ ]  Prefill booking messages with Voucher reference, Discount, and expiry
- [ ]  Do not automatically send customer personal data
- [ ]  Do not require a Service selection to activate a Voucher
- [ ]  Keep the Voucher as a general Discount—not a service-specific offer
- [ ]  Display the seven-day validity rule before activation
- [ ]  Explain that the Voucher must remain Active when booking and on the Treatment date

## 10. Microsite content and localization

- [ ]  Tenant Admin can manage texts, images, highlighted services, prices, trust content, location details, and contact channels
- [ ]  English and Vietnamese content fields
- [ ]  Prevent publication until required English and Vietnamese content is complete
- [ ]  Support additional customer-facing languages when complete
- [ ]  Language selection priority:
    1. Previously selected supported language
    2. Browser/device language
    3. English fallback
- [ ]  Visible language switcher
- [ ]  Anonymous storage of the selected language
- [ ]  Technical language-completeness validation
- [ ]  Use approved Number160 content and imagery from the maintained source

## 11. Anonymous Voucher activation

- [ ]  Activate without customer registration or identification
- [ ]  Require no name, email, telephone number, app, or customer account
- [ ]  Generate a unique Voucher QR and short reference
- [ ]  Set expiry to activation timestamp plus exactly seven days
- [ ]  Display expiry in Vietnam local time
- [ ]  Enforce single-use and no-stacking rules
- [ ]  Allow multiple anonymous Active Vouchers without customer deduplication
- [ ]  Store an immutable financial snapshot at activation
- [ ]  Persist the Voucher anonymously in the same browser/device
- [ ]  Redisplay the Voucher when the same Referral QR is rescanned on that device
- [ ]  Clearly explain where the Voucher is stored and how to retain it
- [ ]  Provide:
    - Save Voucher
    - Download image
    - Native sharing as a secondary action
    - Continue to Voucher
- [ ]  Do not implement Apple Wallet or Google Wallet in V1

## 12. Active Voucher experience

- [ ]  Number160 branding and Partner context
- [ ]  Active, Used, and Expired states
- [ ]  Customer Discount
- [ ]  Voucher QR and short reference
- [ ]  Exact expiry date/time
- [ ]  Remaining-validity indicator
- [ ]  Booking and Treatment-date instructions
- [ ]  Single-use and no-stacking explanation
- [ ]  Save and Download actions
- [ ]  Only show configured contact channels
- [ ]  Clearly state that an expired Voucher cannot be used

## 13. Counter validation and Redemption

- [ ]  Mobile-first Counter experience, optionally installable as a PWA
- [ ]  Require an authenticated individual Staff or Manager account
- [ ]  Require a live internet connection
- [ ]  Scan and validate Voucher QR codes
- [ ]  Ensure a normal browser/camera scan never validates or redeems
- [ ]  Show clear verdicts:
    - Valid
    - Used
    - Expired
    - Blocked or otherwise invalid
    - Connectivity failure
- [ ]  Show Partner organization name where permitted
- [ ]  Hide individual Referrer identity and commission details from Staff
- [ ]  Allow invoice amount entry
- [ ]  Calculate and display Customer Discount and payable amount
- [ ]  Require explicit Redemption confirmation
- [ ]  Make retries idempotent
- [ ]  Record employee and timestamp
- [ ]  Do not queue offline Redemptions

## 14. Financial calculations

- [ ]  Centrally configurable Tenant VAT rate
- [ ]  Redemption calculation order:
    1. Customer Discount on gross invoice amount
    2. Discounted gross payable
    3. VAT removal
    4. Net/Net commission base
    5. Company and/or Individual commission
- [ ]  Calculate commissions only on Net/Net excluding VAT
- [ ]  Store all calculation inputs and outputs
- [ ]  Use immutable financial snapshots
- [ ]  Display VND without decimal places where required
- [ ]  Ensure all displayed amounts reconcile at the displayed precision

## 15. Redemption voiding and corrections

- [ ]  Allow only Managers to void an eligible Redemption
- [ ]  Require a void reason
- [ ]  Preserve the original Redemption and reversal
- [ ]  Reverse financial results rather than overwrite records
- [ ]  Return the Voucher to Active only if it has not expired
- [ ]  Set it to Expired if the original validity window has ended
- [ ]  Prevent normal voiding after the commission is included in a Paid Settlement
- [ ]  Keep post-payment corrections outside the standard V1 workflow

## 16. Payout profiles and VietQR

- [ ]  Payout Profile fields:
    - Bank/VietQR image
    - Beneficiary name
    - Bank name
    - Bank-account number
    - Last-changed user and timestamp
    - Verification status
- [ ]  Verification states:
    - Pending verification
    - Verified
- [ ]  Reset verification after payout-detail changes
- [ ]  Block payout completion until the profile is verified
- [ ]  Apply verification responsibility correctly:
    - Tenant Admin verifies Companies
    - Tenant Admin verifies independent Referrers
    - Partner Admin verifies affiliated Referrers
- [ ]  Display the QR, amount, and expected beneficiary during manual payment
- [ ]  Record payments without moving money through Connect

## 17. Settlements

- [ ]  Create an open commission item after each confirmed, non-voided Redemption
- [ ]  Maintain running unpaid balances
- [ ]  Select one or more unpaid items for Settlement
- [ ]  Support on-demand Settlement without a fixed cycle
- [ ]  Prevent an item from entering multiple completed Settlements
- [ ]  Require:
    - Paid amount
    - Payment date/time
    - Paying user
    - Recipient
    - Transfer-completed confirmation
- [ ]  Support optional bank reference, receipt, and internal note
- [ ]  Distinguish `Paid with evidence` from `Paid without evidence`
- [ ]  Make completed payment records immutable
- [ ]  Allow Partner Admins to record payments to affiliated Referrers
- [ ]  Keep unpaid obligations visible until a truthful payout is recorded

## 18. Reporting and export

- [ ]  Report the funnel:
    - Referral Link Opens
    - Voucher Activations
    - Redemptions
    - Revenue
    - Commission
    - Paid
- [ ]  Use event-based language—not “customers” or “unique visitors”
- [ ]  Tenant-wide reporting with permitted drill-down
- [ ]  Company-level Partner Admin reporting
- [ ]  Personal Referrer reporting
- [ ]  Financial metrics including gross value, Discount, payable amount, VAT, Net/Net base, commission, open balance, and paid amount
- [ ]  Transaction and Settlement detail
- [ ]  Role- and scope-limited CSV export
- [ ]  Basic search, date filters, and practical operational filters

## 19. Audit history and visibility

- [ ]  Immutable audit events for approvals, allocation changes, Redemptions, voids, status transitions, profile verification, and Settlements
- [ ]  Record actor, timestamp, previous state, and new state
- [ ]  Separate internal and Partner-visible history
- [ ]  Show Partners only actions and Tenant decisions affecting their scope
- [ ]  Hide internal notes, deliberations, support actions, and security data
- [ ]  Preserve history after records are Ended, Blocked, Replaced, or Paid

## Production dependencies before launch

- [ ]  Accounting/developer validation of VAT, fixed precision, Net/Net calculations, and VND rounding
- [ ]  Security design for sessions, invitations, reset tokens, rate limiting, and support access
- [ ]  Exact Microsite URL, DNS, deployment, and content-synchronization design
- [ ]  Approved Number160 treatments, prices, photography, and content source
- [ ]  Native Vietnamese editorial review
- [ ]  Counter device and connectivity testing
- [ ]  Assignment of named authorized pilot users


Explicitly outside V1
    Marketplace and Partner discovery
    CRM and prospect management
    Customer accounts or identified-customer analytics
    Native booking system
    Automated banking or direct VietQR payment execution
    Service catalog administration
    Service-specific offers or Vouchers
    Campaign and brochure-batch attribution
    Offline Redemption
    Multiple Number160 service locations
    Custom report builder and scheduled reports
    Apple Wallet and Google Wallet
    Advanced Card logistics and inventory
    Chargebacks and automated post-payment adjustments