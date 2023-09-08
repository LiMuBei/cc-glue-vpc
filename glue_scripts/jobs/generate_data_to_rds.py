import sys
import ssl
import awswrangler as wr

import glue_job_lib.data_generation as data_generation


if __name__ == "__main__":
    from awsglue.utils import getResolvedOptions

    args = getResolvedOptions(
        sys.argv,
        [
            "region",
            "db_secret",
            "target_schema",
            "target_table",
        ],
    )

    data = data_generation.generate_data()

    # Need to set this so data wrangler can retrieve temp credentials
    wr.config.sts_endpoint_url = f'https://sts.{args["region"]}.amazonaws.com'

    # Get PSQL connection
    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS)
    ssl_context.verify_mode = ssl.CERT_REQUIRED
    ssl_context.load_verify_locations(cafile="glue_job_lib/eu-west-1-bundle.cert", capath=None, cadata=None)

    with wr.postgresql.connect(secret_id=args["db_secret"], ssl_context=ssl_context) as conn:
        wr.postgresql.to_sql(
            df=data,
            con=conn,
            schema=args["db_schema"],
            table=args["db_table"],
            mode="append",
            use_column_names=True
        )
