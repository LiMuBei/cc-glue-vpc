// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { Construct } from 'constructs';
import { App, Fn, TerraformStack } from 'cdktf';
import { AwsProvider } from '@cdktf/provider-aws/lib/provider';
import { Vpc } from '@cdktf/provider-aws/lib/vpc';
import { S3Bucket } from '@cdktf/provider-aws/lib/s3-bucket';
import { RdsCluster } from '@cdktf/provider-aws/lib/rds-cluster';
import { SecurityGroup } from '@cdktf/provider-aws/lib/security-group';
import { SecurityGroupRule } from '@cdktf/provider-aws/lib/security-group-rule';
import { RandomProvider } from '@cdktf/provider-random/lib/provider';
import { Subnet } from '@cdktf/provider-aws/lib/subnet';
import { DbSubnetGroup } from '@cdktf/provider-aws/lib/db-subnet-group';
import { s3BucketPublicAccessBlock } from '@cdktf/provider-aws';
import { IamRole } from '@cdktf/provider-aws/lib/iam-role';
import { IamPolicy } from '@cdktf/provider-aws/lib/iam-policy';
import { DataAwsIamPolicyDocument } from '@cdktf/provider-aws/lib/data-aws-iam-policy-document';
import { GlueJob } from '@cdktf/provider-aws/lib/glue-job';
import { S3Object } from '@cdktf/provider-aws/lib/s3-object';
import { GlueConnection } from '@cdktf/provider-aws/lib/glue-connection';
import { InternetGateway } from '@cdktf/provider-aws/lib/internet-gateway';
import { RouteTable } from '@cdktf/provider-aws/lib/route-table';
import { Route } from '@cdktf/provider-aws/lib/route';
import { RouteTableAssociation } from '@cdktf/provider-aws/lib/route-table-association';
import { NatGateway } from '@cdktf/provider-aws/lib/nat-gateway';
import { Eip } from '@cdktf/provider-aws/lib/eip';
import { RdsClusterInstance } from '@cdktf/provider-aws/lib/rds-cluster-instance';

class MyStack extends TerraformStack {
    constructor(scope: Construct, id: string) {
        super(scope, id);

        new AwsProvider(this, 'aws', {
            region: 'eu-central-1'
        });

        new RandomProvider(this, 'random');

        // Setup network
        const { vpcId, isolatedSubnetA, isolatedSubnetB, privateSubnet } = this.setupNetworking();
        const { rdsSecurityGroup, glueJobsSecurityGroup } = this.setupSecurityGroups(vpcId);

        // This is the S3 bucket where the Glue job script and resources will live
        const glueScriptsBucket = new S3Bucket(this, 'glue-bucket', {
            bucket: 'gluescripts.akasper.codecentric.de'
        });
        // Block public access
        new s3BucketPublicAccessBlock.S3BucketPublicAccessBlock(this, 'glue-bucket-public-access-block', {
            bucket: glueScriptsBucket.bucket,
            blockPublicAcls: true,
            blockPublicPolicy: true,
            ignorePublicAcls: true,
            restrictPublicBuckets: true
        });

        // The RDS master user password
        const rdsCluster = this.setupRds(rdsSecurityGroup, [isolatedSubnetA.id, isolatedSubnetB.id]);

        // Create connection for Glue jobs to access RDS
        const rdsConnection = new GlueConnection(this, 'rds-connection', {
            name: 'rds-connection',
            connectionProperties: {
                JDBC_CONNECTION_URL: `jdbc:postgresql://${rdsCluster.endpoint}/${rdsCluster.databaseName}`,
                JDBC_ENFORCE_SSL: 'true',
                SECRET_ID: rdsCluster.masterUserSecret.get(0).secretArn
            },
            physicalConnectionRequirements: {
                availabilityZone: privateSubnet.availabilityZone,
                securityGroupIdList: [glueJobsSecurityGroup.id],
                subnetId: privateSubnet.id
            }
        });

        // The Glue job
        // Note: we're using the master credentials to access the RDS DB in the job, this is not recommended for production use
        this.createGlueJob(glueScriptsBucket, rdsCluster.masterUserSecret.get(0).secretArn, rdsConnection);
    }

    private setupRds(rdsSecurityGroup: SecurityGroup, subnetIds: string[]) {
        // RDS subnet group
        const subnetGroup = new DbSubnetGroup(this, 'rds-subnet-group', {
            name: 'rds-subnet-group',
            subnetIds: subnetIds
        });

        // The RDS cluster
        // This is the RDS cluster where the Glue job will write to
        const rdsCluster = new RdsCluster(this, 'rds-cluster', {
            clusterIdentifier: 'rds-cluster',
            engine: 'aurora-postgresql',
            engineMode: 'provisioned',
            engineVersion: '15.3',
            databaseName: 'glue',
            masterUsername: 'dbadmin',
            manageMasterUserPassword: true,
            vpcSecurityGroupIds: [rdsSecurityGroup.id],
            dbSubnetGroupName: subnetGroup.name,
            skipFinalSnapshot: true,
            serverlessv2ScalingConfiguration: {
                maxCapacity: 1,
                minCapacity: 0.5
            }
        });
        // Create RDS instance (single instance, not for production use)
        new RdsClusterInstance(this, 'rds-cluster-instance', {
            identifier: 'rds-cluster-instance',
            clusterIdentifier: rdsCluster.clusterIdentifier,
            instanceClass: 'db.serverless',
            engine: rdsCluster.engine,
            engineVersion: rdsCluster.engineVersion
        });

        return rdsCluster;
    }

    private setupNetworking() {
        // This is the VPC we want to deploy our resources into
        const vpc = new Vpc(this, 'vpc', {
            cidrBlock: '10.0.0.0/16',
            enableDnsHostnames: true,
            enableDnsSupport: true
        });

        // Create isolated subnets (for the RDS database)
        const isolatedSubnetA = new Subnet(this, 'isolated-subnet-a', {
            vpcId: vpc.id,
            cidrBlock: '10.0.1.0/24',
            availabilityZone: 'eu-central-1a',
            mapPublicIpOnLaunch: false,
            tags: {
                Name: 'isolated-subnet-a'
            }
        });
        const isolatedSubnetB = new Subnet(this, 'isolated-subnet-b', {
            vpcId: vpc.id,
            cidrBlock: '10.0.2.0/24',
            availabilityZone: 'eu-central-1b',
            mapPublicIpOnLaunch: false,
            tags: {
                Name: 'isolated-subnet-b'
            }
        });

        // Create private subnet (for Glue jobs)
        const privateSubnet = new Subnet(this, 'private-subnet', {
            vpcId: vpc.id,
            cidrBlock: '10.0.3.0/24',
            availabilityZone: 'eu-central-1a',
            mapPublicIpOnLaunch: false,
            tags: {
                Name: 'private-subnet'
            }
        });

        // Create a public subnet for the internet gateway and nat gateway
        const publicSubnet = new Subnet(this, 'public-subnet', {
            vpcId: vpc.id,
            cidrBlock: '10.0.4.0/24',
            availabilityZone: 'eu-central-1a',
            tags: {
                Name: 'public-subnet'
            }
        });

        // Internet gateway for the VPC
        const internetGateway = new InternetGateway(this, 'internet-gateway', {
            vpcId: vpc.id
        });

        // Route traffic from public subnet to internet gateway
        const publicSubnetRouteTable = new RouteTable(this, 'public-subnet-route-table', {
            vpcId: vpc.id
        });
        new RouteTableAssociation(this, 'public-subnet-route-table-association', {
            routeTableId: publicSubnetRouteTable.id,
            subnetId: publicSubnet.id
        });
        new Route(this, 'public-subnet-route', {
            routeTableId: publicSubnetRouteTable.id,
            destinationCidrBlock: '0.0.0.0/0',
            gatewayId: internetGateway.id
        });

        // Elastic IP for NAT gateway
        const elasticIp = new Eip(this, 'elastic-ip', {
            vpc: true
        });
        // Setup NAT gateway for glue subnet
        const natGateway = new NatGateway(this, 'nat-gateway', {
            allocationId: elasticIp.id,
            subnetId: publicSubnet.id
        });
        // Route traffic from glue subnet to NAT gateway
        const privateSubnetRouteTable = new RouteTable(this, 'private-subnet-route-table', {
            vpcId: vpc.id
        });
        new RouteTableAssociation(this, 'private-subnet-route-table-association', {
            routeTableId: privateSubnetRouteTable.id,
            subnetId: privateSubnet.id
        });
        new Route(this, 'private-subnet-route', {
            routeTableId: privateSubnetRouteTable.id,
            destinationCidrBlock: '0.0.0.0/0',
            natGatewayId: natGateway.id
        });

        return {
            vpcId: vpc.id,
            isolatedSubnetA: isolatedSubnetA,
            isolatedSubnetB: isolatedSubnetB,
            privateSubnet: privateSubnet,
            publicSubnet: publicSubnet
        };
    }

    private setupSecurityGroups(vpcId: string) {
        // This limits the traffic to the RDS database
        const rdsSecurityGroup = new SecurityGroup(this, 'rds-security-group', {
            name: 'rds-security-group',
            description: 'Security group for RDS database',
            vpcId: vpcId
        });

        // This limits the traffic to and from the Glue jobs
        const glueJobsSecurityGroup = new SecurityGroup(this, 'glue-jobs-security-group', {
            name: 'glue-jobs-security-group',
            description: 'Security group for Glue jobs',
            vpcId: vpcId
        });

        // Allow Glue jobs security group to access RDS security group
        new SecurityGroupRule(this, 'rds-security-group-ingress', {
            type: 'ingress',
            securityGroupId: rdsSecurityGroup.id,
            description: 'Allow Glue jobs to access RDS',
            fromPort: 5432,
            toPort: 5432,
            protocol: 'tcp',
            sourceSecurityGroupId: glueJobsSecurityGroup.id
        });

        // Allow incoming connections on all ports within the Glue jobs security group
        // (requirement by Glue)
        new SecurityGroupRule(this, 'glue-jobs-security-group-ingress', {
            type: 'ingress',
            securityGroupId: glueJobsSecurityGroup.id,
            description: 'Allow incoming connections',
            fromPort: 0,
            toPort: 65535,
            protocol: 'tcp',
            sourceSecurityGroupId: glueJobsSecurityGroup.id
        });

        // Allow Glue jobs security group to access internet
        // (requirement by Glue, plus allows access to pypi.org for installing Python packages)
        new SecurityGroupRule(this, 'glue-jobs-security-group-egress', {
            type: 'egress',
            securityGroupId: glueJobsSecurityGroup.id,
            description: 'Allow Glue jobs to access internet',
            fromPort: 0,
            toPort: 65535,
            protocol: 'tcp',
            cidrBlocks: ['0.0.0.0/0']
        });

        return { rdsSecurityGroup, glueJobsSecurityGroup };
    }

    private createGlueJob(glueScriptsBucket: S3Bucket, rdsMasterUserSecretArn: string, rdsConnection: GlueConnection) {
        const jobPolicyDocument = new DataAwsIamPolicyDocument(this, 'glue-job-policy-document', {
            version: '2012-10-17',
            statement: [
                {
                    sid: 'GlueJobAllowS3Access',
                    effect: 'Allow',
                    actions: ['s3:GetObject', 's3:ListBucket'],
                    resources: [`${glueScriptsBucket.arn}/*`, `${glueScriptsBucket.arn}`]
                },
                {
                    sid: 'GlueJobAllowRdsSecretAccess',
                    effect: 'Allow',
                    actions: ['secretsmanager:GetSecretValue'],
                    resources: [rdsMasterUserSecretArn]
                }
            ]
        });

        const jobPolicy = new IamPolicy(this, 'glue-job-policy', {
            name: 'glue-job-policy',
            policy: jobPolicyDocument.json
        });

        const jobRole = new IamRole(this, 'glue-job-role', {
            name: 'glue-job-role',
            assumeRolePolicy: JSON.stringify({
                Version: '2012-10-17',
                Statement: [
                    {
                        Effect: 'Allow',
                        Principal: {
                            Service: 'glue.amazonaws.com'
                        },
                        Action: 'sts:AssumeRole'
                    }
                ]
            }),
            managedPolicyArns: [jobPolicy.arn, 'arn:aws:iam::aws:policy/service-role/AWSGlueServiceRole']
        });

        // Upload job script to S3
        new S3Object(this, 'glue_job_script', {
            bucket: glueScriptsBucket.id,
            key: 'generate_data_to_rds.py',
            source: `${__dirname}/glue_scripts/jobs/generate_data_to_rds.py`,
            sourceHash: Fn.filemd5(`${__dirname}/glue_scripts/jobs/generate_data_to_rds.py`)
        });

        // Upload job Python package to S3
        new S3Object(this, 'glue_job_lib', {
            bucket: glueScriptsBucket.id,
            key: 'glue_scripts-0.1.0-py3-none-any.whl',
            source: `${__dirname}/glue_scripts/dist/glue_scripts-0.1.0-py3-none-any.whl`,
            sourceHash: Fn.filemd5(`${__dirname}/glue_scripts/dist/glue_scripts-0.1.0-py3-none-any.whl`)
        });

        new GlueJob(this, 'glue-job', {
            name: 'glue-job',
            command: {
                name: 'pythonshell',
                pythonVersion: '3.9',
                scriptLocation: `s3://${glueScriptsBucket.id}/generate_data_to_rds.py`
            },
            connections: [rdsConnection.name], // This puts the Glue job in the same VPC as the RDS database
            glueVersion: '3.0',
            maxCapacity: 0.0625,
            executionClass: 'STANDARD',
            defaultArguments: {
                '--enable-metrics': 'true',
                '--job-language': 'python',
                'library-set': 'analytics', // This allows us to use AWSWrangler, Pandas etc. in the Glue job
                '--enable-job-insights': 'false',
                '--extra-py-files': `s3://${glueScriptsBucket.id}/glue_scripts-0.1.0-py3-none-any.whl`
            },
            roleArn: jobRole.arn,
            timeout: 60
        });
    }
}

const app = new App();
new MyStack(app, 'glue-vpc-article');
app.synth();
